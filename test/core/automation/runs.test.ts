// Documented behaviour: daemon.md "Execution" — the daemon runs a spawn as
// `pi --mode rpc` with its run file (extension.md "Headless sessions":
// `--vault-run`, holding vault, document, actor, trace and event), in the
// actor's worktree; "Spawn lifecycle" — queued → running → committed,
// no-change or stopped (budget, ttl, error) → recorded; "Scheduling" — within
// capacity, one job per actor; "Start-up recovery" — it records the exact
// process of each session it starts; "Integrity" — a vault with an
// unaccepted change runs nothing. A fake pi stands in for Pi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listSpawns, runProcesses } from '../../../src/core/queue/index.ts';
import { readFullLog } from '../../../src/core/traces/index.ts';
import { automationFor, fakePi, jobDocument } from '../../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';

const MANUAL = '[{ on: external, name: go, effect: spawn }]';

function jobs(t: TestInstallation, documents: Record<string, string>): void {
  for (const [path, text] of Object.entries(documents)) t.repo.write(path, text);
  t.accept(t.repo.commit('jobs'));
}

test('a queued spawn runs as pi --mode rpc in its actor\'s worktree with its run file; a commit makes it committed', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL) });
  assert.equal((await t.run('run', { document: 'jobs/a.md' })).status, 'ok');
  const pi = fakePi(t, { 'jobs/a.md': 'commit' });
  const automation = automationFor(t, pi);
  const notices: unknown[] = [];
  automation.watch((notice) => notices.push(notice));
  const started = await automation.schedule();
  assert.equal(started.length, 1);
  await automation.idle();

  const [start] = pi.starts();
  const [spawn] = listSpawns(t.context.state);
  assert.ok(start !== undefined && spawn !== undefined);
  assert.deepEqual(start.argv.slice(0, 2), ['--mode', 'rpc']);
  assert.equal(start.argv[start.argv.indexOf('--session-id') + 1], spawn.trace, 'its Pi session is named by its trace');
  assert.equal(start.cwd, join(t.vault.worktrees, 'gardener'));
  assert.deepEqual(start.run, { vault: 'home', document: 'jobs/a.md', actor: 'gardener', trace: spawn.trace, event: spawn.event });
  assert.equal(spawn.state, 'recorded');
  assert.match(spawn.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(t.repo.git('rev-parse', 'actor/gardener'), spawn.commit);
  assert.deepEqual(runProcesses(t.context.state), [], 'its process is no longer recorded');
  assert.deepEqual(notices.map((n) => (n as { state: string }).state), ['started', 'finished']);
  assert.ok(readFullLog(t.installation.paths.logs, spawn.trace).some((l) => l.name === 'daemon'), 'the run\'s lifecycle in its full log');
  assert.equal(existsSync(join(t.installation.paths.runs, `${spawn.trace}.json`)), false, 'its run file is removed once it has ended');
}));

test('a run that changes nothing is no-change; one that crashes is stopped with error', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL), 'jobs/b.md': jobDocument(MANUAL, { actor: 'librarian' }) });
  await t.run('trigger', { name: 'go' });
  const automation = automationFor(t, fakePi(t, { 'jobs/a.md': 'nothing', 'jobs/b.md': 'crash' }));
  await automation.schedule();
  await automation.idle();
  const ended = Object.fromEntries(listSpawns(t.context.state).map((s) => [s.document, `${s.reason ?? ''}`]));
  assert.deepEqual(ended, { 'jobs/a.md': '', 'jobs/b.md': 'error' });
  const audit = t.context.state.all<{ document: string; state: string }>("SELECT document, state FROM queue_spawns ORDER BY document");
  assert.deepEqual(audit.map((r) => r.state), ['recorded', 'recorded']);
  const noChange = readFullLog(t.installation.paths.logs, listSpawns(t.context.state)[0]?.trace ?? '').find((l) => l.name === 'daemon');
  assert.match(noChange?.text ?? '', /"outcome":"no-change"/);
}, { contract: { actors: ['gardener', 'librarian'] } }));

test('a run past its run time is killed and stopped with ttl; one past its budget is stopped with budget', withInstallation(async (t) => {
  jobs(t, { 'jobs/slow.md': jobDocument(MANUAL, { ttl: '1s' }), 'jobs/costly.md': jobDocument(MANUAL, { actor: 'librarian' }) });
  await t.run('trigger', { name: 'go' });
  const automation = automationFor(t, fakePi(t, { 'jobs/slow.md': 'hang', 'jobs/costly.md': 'spend' }), { graceMs: 200 });
  await automation.schedule();
  await automation.idle();
  const ended = Object.fromEntries(listSpawns(t.context.state).map((s) => [s.document, s.reason]));
  assert.deepEqual(ended, { 'jobs/costly.md': 'budget', 'jobs/slow.md': 'ttl' });
}, { contract: { actors: ['gardener', 'librarian'] } }));

test('one job per actor at a time, within capacity: the next starts when the first has ended', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL), 'jobs/b.md': jobDocument(MANUAL) });
  await t.run('trigger', { name: 'go' });
  const pi = fakePi(t, { '*': 'nothing' });
  const automation = automationFor(t, pi);
  assert.equal((await automation.schedule()).length, 1, 'both are gardener\'s');
  await automation.idle();
  assert.equal((await automation.schedule()).length, 1);
  await automation.idle();
  assert.deepEqual(listSpawns(t.context.state).map((s) => s.state), ['recorded', 'recorded']);
}, { config: 'daemon: { parallel: 4 }' }));

test('a vault with an unaccepted change runs nothing; its queued work waits', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL) });
  await t.run('run', { document: 'jobs/a.md' });
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  const pi = fakePi(t, { '*': 'nothing' });
  const automation = automationFor(t, pi);
  assert.deepEqual(await automation.schedule(), []);
  assert.deepEqual(pi.starts(), []);
  assert.equal(listSpawns(t.context.state)[0]?.state, 'queued');
}));

test('a job that requires its originating session does not run without one', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument('[{ on: external, name: go, effect: spawn, context: session-required }]') });
  await t.run('trigger', { name: 'go' });
  const pi = fakePi(t, { '*': 'nothing' });
  const automation = automationFor(t, pi);
  await automation.schedule();
  await automation.idle();
  assert.deepEqual(listSpawns(t.context.state).map((s) => s.reason), ['no-session']);
  assert.deepEqual(pi.starts(), []);
}));
