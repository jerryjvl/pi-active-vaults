// Documented behaviour: daemon.md "Execution" — the daemon runs a spawn as
// `pi --mode rpc` with its run file (extension.md "Headless sessions":
// `--vault-run`, holding vault, document, actor, model and trace and event), in the
// actor's worktree, with `--model` the `agent` model the job asks for (else the
// default) that the policy allows for its vault — a spawn with none is stopped
// `no-model` and nothing else is affected; "Spawn lifecycle" — queued → running → committed,
// no-change or stopped (budget, ttl, error) → recorded — a run that commits
// nothing and whose last model request ended in an error is stopped
// `error`, one that committed stays `committed` with the error in its trace; "Scheduling" — within
// capacity, one job per actor; "Start-up recovery" — it records the exact
// process of each session it starts; "Integrity" — a vault with an
// unaccepted change runs nothing. A fake pi stands in for Pi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSpawns, runProcesses } from '../../../src/core/queue/index.ts';
import { readFullLog } from '../../../src/core/traces/index.ts';
import { automationFor, fakePi, jobDocument } from '../../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { AGENT_MODEL } from '../../support/models.ts';

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
  assert.deepEqual(start.argv.slice(0, 4), ['--mode', 'rpc', '--model', AGENT_MODEL]);
  assert.equal(start.argv[start.argv.indexOf('--session-id') + 1], spawn.trace, 'its Pi session is named by its trace');
  assert.equal(start.cwd, join(t.vault.worktrees, 'gardener'));
  assert.deepEqual(start.run, { vault: 'home', document: 'jobs/a.md', actor: 'gardener', model: 'agent', trace: spawn.trace, event: spawn.event });
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
}, { contract: { actors: ['gardener', 'librarian'] }, config: 'daemon: { parallel: 2 }' }));

test('a run that commits nothing after a failed model request is stopped with error; one that committed stays committed, the error in its trace; one that recovered is no-change', withInstallation(async (t) => {
  jobs(t, {
    'jobs/a.md': jobDocument(MANUAL),
    'jobs/b.md': jobDocument(MANUAL, { actor: 'librarian' }),
    'jobs/c.md': jobDocument(MANUAL, { actor: 'curator' }),
  });
  await t.run('trigger', { name: 'go' });
  const automation = automationFor(t, fakePi(t, { 'jobs/a.md': 'fail', 'jobs/b.md': 'commit-then-fail', 'jobs/c.md': 'recover' }));
  await automation.schedule();
  await automation.idle();
  const spawns = Object.fromEntries(listSpawns(t.context.state).map((s) => [s.document, s]));
  const ended = (document: string) => readFullLog(t.installation.paths.logs, spawns[document]?.trace ?? '')
    .filter((l) => l.name === 'daemon').flatMap((l) => l.text.trim().split('\n')).map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record['event'] === 'ended');
  assert.deepEqual([spawns['jobs/a.md']?.reason, ended('jobs/a.md')?.['outcome']], ['error', 'stopped'], 'not no-change: the run could not do its work');
  assert.match(String(ended('jobs/a.md')?.['modelError']), /Connection error/);
  assert.match(spawns['jobs/b.md']?.commit ?? '', /^[0-9a-f]{40}$/);
  assert.equal(spawns['jobs/b.md']?.reason, undefined, 'what it committed stands');
  assert.equal(ended('jobs/b.md')?.['outcome'], 'committed');
  assert.match(String(ended('jobs/b.md')?.['modelError']), /Connection error/, 'the error is in its trace');
  assert.deepEqual([spawns['jobs/c.md']?.reason, ended('jobs/c.md')?.['outcome'], ended('jobs/c.md')?.['modelError']], [undefined, 'no-change', undefined], 'its last request ended normally');
}, { contract: { actors: ['gardener', 'librarian', 'curator'] }, config: 'daemon: { parallel: 3 }' }));

test('a run past its run time is killed and stopped with ttl; one past its budget is stopped with budget', withInstallation(async (t) => {
  jobs(t, { 'jobs/slow.md': jobDocument(MANUAL, { ttl: '1s' }), 'jobs/costly.md': jobDocument(MANUAL, { actor: 'librarian' }) });
  await t.run('trigger', { name: 'go' });
  const automation = automationFor(t, fakePi(t, { 'jobs/slow.md': 'hang', 'jobs/costly.md': 'spend' }), { graceMs: 200 });
  await automation.schedule();
  await automation.idle();
  const ended = Object.fromEntries(listSpawns(t.context.state).map((s) => [s.document, s.reason]));
  assert.deepEqual(ended, { 'jobs/costly.md': 'budget', 'jobs/slow.md': 'ttl' });
}, { contract: { actors: ['gardener', 'librarian'] }, config: 'daemon: { parallel: 2 }' }));

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

// concepts.md "Models", daemon.md "Execution": the model a spawn runs on.
const AGENTS = 'models:\n  agent: { model: fake/big }\n  quick: { role: agent, model: fake/small }\n';
const allowing = (...names: string[]): string => `policy:\n  - { vaults: [home], allow-models: [${names.join(', ')}] }`;

test('Pi is started with the model the job asks for, else the default agent; the run file names it', withInstallation(async (t) => {
  jobs(t, { 'jobs/plain.md': jobDocument(MANUAL), 'jobs/quick.md': jobDocument(MANUAL, { model: 'quick', actor: 'librarian' }) });
  await t.run('trigger', { name: 'go' });
  const pi = fakePi(t, { '*': 'nothing' });
  const automation = automationFor(t, pi);
  await automation.schedule();
  await automation.idle();
  const byDocument = Object.fromEntries(pi.starts().map((s) => [s.run?.['document'], [s.argv[s.argv.indexOf('--model') + 1], s.run?.['model']]]));
  assert.deepEqual(byDocument, { 'jobs/plain.md': ['fake/big', 'agent'], 'jobs/quick.md': ['fake/small', 'quick'] });
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.document, s.model]), [['jobs/plain.md', 'agent'], ['jobs/quick.md', 'quick']]);
}, { noDefaultModels: true, contract: { actors: ['gardener', 'librarian'] }, config: `${AGENTS}${allowing('agent', 'quick')}\ndaemon: { parallel: 2 }` }));

test('a job whose model the policy does not allow is stopped no-model and never started, and nothing else is affected', withInstallation(async (t) => {
  jobs(t, { 'jobs/plain.md': jobDocument(MANUAL), 'jobs/quick.md': jobDocument(MANUAL, { model: 'quick', actor: 'librarian' }) });
  await t.run('trigger', { name: 'go' });
  const pi = fakePi(t, { '*': 'nothing' });
  const automation = automationFor(t, pi);
  await automation.schedule();
  await automation.idle();
  assert.deepEqual(pi.starts().map((s) => s.run?.['document']), ['jobs/plain.md'], 'the job\'s content reached no model the policy does not allow, not even the default');
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.document, s.state, s.reason ?? '']), [['jobs/plain.md', 'recorded', ''], ['jobs/quick.md', 'stopped', 'no-model']]);
}, { noDefaultModels: true, contract: { actors: ['gardener', 'librarian'] }, config: `${AGENTS}${allowing('agent')}\ndaemon: { parallel: 2 }` }));

test('with no agent model configured every job is stopped no-model, and the vault still works', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL) });
  const triggered = await t.run('trigger', { name: 'go' });
  assert.equal(triggered.status, 'ok');
  assert.match(triggered.text, /jobs\/a\.md was not queued: no-model/);
  const pi = fakePi(t, { '*': 'commit' });
  const automation = automationFor(t, pi);
  assert.deepEqual(await automation.schedule(), []);
  assert.deepEqual(pi.starts(), []);
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.state, s.reason]), [['stopped', 'no-model']]);
  assert.equal((await t.run('status')).status, 'ok');
}, { noDefaultModels: true }));

test('a policy that no longer allows the model by the time a queued spawn would start stops it: the model is checked again, not trusted from the claim', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL) });
  assert.equal((await t.run('run', { document: 'jobs/a.md' })).status, 'ok');
  assert.equal(listSpawns(t.context.state)[0]?.state, 'queued');
  writeFileSync(t.dir.file('config', 'config.yaml'), readFileSync(t.dir.file('config', 'config.yaml'), 'utf8').replace(/policy:[\s\S]*$/, 'policy: []\n'));
  const later = t.reload();
  const pi = fakePi(later, { '*': 'commit' });
  await automationFor(later, pi).schedule();
  assert.deepEqual(pi.starts(), []);
  assert.deepEqual(listSpawns(later.context.state).map((s) => [s.state, s.reason]), [['recorded', 'no-model']]);
}));

test('a model that was removed from the config after the claim is not replaced by the default', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL, { model: 'quick' }) });
  assert.equal((await t.run('run', { document: 'jobs/a.md' })).status, 'ok');
  assert.equal(listSpawns(t.context.state)[0]?.model, 'quick');
  writeFileSync(t.dir.file('config', 'config.yaml'), readFileSync(t.dir.file('config', 'config.yaml'), 'utf8').replace('  quick: { role: agent, model: fake/small }\n', ''));
  const later = t.reload();
  const pi = fakePi(later, { '*': 'commit' });
  await automationFor(later, pi).schedule();
  assert.deepEqual(pi.starts(), []);
  assert.equal(listSpawns(later.context.state)[0]?.reason, 'no-model');
}, { noDefaultModels: true, config: `${AGENTS}${allowing('agent', 'quick')}` }));

test('a job\'s actor branch is brought up to date with the accepted main before Pi starts, so it never works on stale content', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL) });
  await t.run('trigger', { name: 'go' });
  const first = automationFor(t, fakePi(t, { 'jobs/a.md': 'commit' }));
  await first.schedule();
  await first.idle();
  // The owner changes main meanwhile; the branch's own work is not yet accepted.
  t.repo.write('notes/owner.md', 'Corrected by hand.');
  const corrected = t.repo.commit('owner correction');
  t.accept(corrected);
  await t.run('trigger', { name: 'go' });
  const second = automationFor(t, fakePi(t, { 'jobs/a.md': 'commit' }));
  await second.schedule();
  await second.idle();
  assert.equal(t.repo.git('merge-base', '--is-ancestor', corrected, 'actor/gardener'), '', 'the branch includes the accepted main');
  const last = listSpawns(t.context.state).at(-1);
  assert.equal(last?.state, 'recorded');
  assert.equal(last?.reason ?? '', '');
}));

test('a branch that conflicts with the accepted main stops the run out-of-date, and Pi is not started', withInstallation(async (t) => {
  jobs(t, { 'jobs/a.md': jobDocument(MANUAL) });
  await t.run('trigger', { name: 'go' });
  const first = automationFor(t, fakePi(t, { 'jobs/a.md': 'commit' }));
  await first.schedule();
  await first.idle();
  const [made] = listSpawns(t.context.state);
  // The same path, written differently on main: the merge cannot be made.
  t.repo.write(`notes/${made?.trace ?? 'x'}.md`, 'A different version.');
  t.accept(t.repo.commit('conflicting edit'));
  await t.run('trigger', { name: 'go' });
  const pi = fakePi(t, { 'jobs/a.md': 'commit' });
  const before = pi.starts().length; // the log is the installation's, so it holds the first run too
  const second = automationFor(t, pi);
  await second.schedule();
  await second.idle();
  assert.equal(pi.starts().length, before, 'Pi was not started again');
  const last = listSpawns(t.context.state).at(-1);
  assert.equal(last?.reason, 'out-of-date');
}));
