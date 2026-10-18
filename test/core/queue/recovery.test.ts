// Documented behaviour: daemon.md "Start-up recovery" — before anything else
// the daemon ends any headless session left from its previous run, by the
// exact process ID it recorded and only after checking that process's start
// time; marks every running spawn `stopped` with the reason `restart`,
// ending its budget session and releasing its actor; resets the worktree of
// each actor those spawns held to the actor's last commit, saving any
// uncommitted changes to the run's full log first; and leaves queued spawns
// queued. Interactive sessions are not the daemon's and are left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actorHold, ensureActorWorktree, takeActorHold } from '../../../src/core/actors/index.ts';
import { budgetState } from '../../../src/core/budgets/index.ts';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import { processStartTime, startChild } from '../../../src/core/process/index.ts';
import { enqueueSpawn, listSpawns, recordRunProcess, recoverRuns, runProcesses } from '../../../src/core/queue/index.ts';
import { readFullLog } from '../../../src/core/traces/index.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { OTHER_HOLDER, RUNNING, startedSpawn } from '../../support/session.ts';

const sleeper = () => startChild({ program: { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, env: { PATH: process.env['PATH'] } });

function recovery(t: TestInstallation) {
  return recoverRuns({ git: t.context.git, store: t.context.state, alive: (pid) => processStartTime(pid), clock: t.clock, logs: t.installation.paths.logs, vaults: t.installation.vaults });
}

test('recovery ends the recorded session, stops its spawn, releases its actor and resets its worktree, keeping its changes in the log', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const accepted = acceptedMain(t.context.state, 'home');
  assert.ok(accepted !== undefined);
  const worktree = await ensureActorWorktree(t.context.git, t.vault, accepted, 'gardener');
  assert.ok(worktree.ok);
  writeFileSync(join(worktree.value.path, 'half-done.md'), 'Half done.\n');
  writeFileSync(join(worktree.value.path, '_contract.md'), 'Edited, not committed.\n');

  const child = await sleeper();
  assert.ok(child.ok);
  const started = await processStartTime(child.value.pid);
  assert.ok(started.ok && started.value !== undefined);
  recordRunProcess(t.context.state, entry.id, { pid: child.value.pid, started: started.value });
  const holder = { process: { pid: child.value.pid, started: started.value }, session: entry.trace };
  assert.ok((await takeActorHold(t.context.state, (pid) => processStartTime(pid), t.clock, { vault: 'home', actor: 'gardener', holder })).ok);
  const queued = enqueueSpawn(t.context.state, { ids: t.context.ids, clock: t.clock, limits: t.installation.config.budgets }, {
    vault: 'home', document: 'jobs/daily.md', event: { kind: 'manual', id: 'later' }, budget: { tokens: 10, ttlMs: 60_000 }, actor: 'gardener',
  }).entry;

  const report = await recovery(t);
  await child.value.exited;
  assert.deepEqual(report.ended, [child.value.pid]);
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.id, s.state, s.reason]), [[entry.id, 'stopped', 'restart'], [queued.id, 'queued', undefined]]);
  assert.ok(budgetState(t.context.state, t.installation.config.budgets, t.clock, entry.trace) !== undefined);
  assert.equal(t.context.state.get<{ finished: string | null }>('SELECT finished FROM budgets_sessions WHERE trace = ?', [entry.trace])?.finished !== null, true, 'its budget session ended');
  assert.equal(await actorHold(t.context.state, (pid) => processStartTime(pid), 'home', 'gardener'), undefined);
  assert.equal(existsSync(join(worktree.value.path, 'half-done.md')), false);
  assert.equal(readFileSync(join(worktree.value.path, '_contract.md'), 'utf8'), t.repo.git('show', 'actor/gardener:_contract.md') + '\n');
  assert.deepEqual(runProcesses(t.context.state), []);

  const saved = readFullLog(t.installation.paths.logs, entry.trace).filter((l) => l.name === 'recovery').map((l) => l.text).join('');
  assert.match(saved, /half-done\.md/);
  assert.match(saved, /Half done\./);
  assert.match(saved, /Edited, not committed\./);
}, { running: RUNNING }));

test('a recorded process whose ID now belongs to another process is never touched', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const child = await sleeper();
  assert.ok(child.ok);
  try {
    recordRunProcess(t.context.state, entry.id, { pid: child.value.pid, started: 'an-earlier-process' });
    const report = await recovery(t);
    assert.deepEqual(report.ended, []);
    const still = await processStartTime(child.value.pid);
    assert.ok(still.ok && still.value !== undefined, 'still running');
    assert.equal(listSpawns(t.context.state)[0]?.state, 'stopped', 'its spawn is stopped all the same');
  } finally {
    child.value.kill();
    await child.value.exited;
  }
}, { running: RUNNING }));

test('an interactive session\'s hold is left alone', withInstallation(async (t) => {
  startedSpawn(t);
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'alice', holder: OTHER_HOLDER })).ok);
  await recoverRuns({ git: t.context.git, store: t.context.state, alive: t.context.alive, clock: t.clock, logs: t.installation.paths.logs, vaults: t.installation.vaults });
  assert.equal((await actorHold(t.context.state, t.context.alive, 'home', 'alice'))?.holder.session, 'other-session');
}, { running: RUNNING }));
