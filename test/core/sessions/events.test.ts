// Documented behaviour: extension.md "Spawns" and concepts.md "Session tree" —
// a session event that matches a `spawn` condition becomes a spawn request in
// the session's tree; its identity is fixed before it is sent to the daemon or
// queued, so a lost reply still makes one spawn. Session events are what a
// session does — its start, the tools it uses, the paths it touches — each
// counted the first time. A vault with an unaccepted change is paused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueSpawn, listSpawns, spawnEventKey, type SpawnSender } from '../../../src/core/queue/index.ts';
import { sessionEvent } from '../../../src/core/sessions/index.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { RUNNING, openTestSession, runOf, startedSpawn } from '../../support/session.ts';

function job(t: TestInstallation, path: string, on: string, extra = ''): void {
  t.repo.write(path, `---\napplies-when:\n  - { on: ${on}, effect: spawn${extra} }\nbudget: { tokens: 1000, ttl: 10m }\nactor: gardener\n---\nRun.\n`);
}

test('a session event that matches a job spawns it once, in the session\'s tree', withInstallation(async (t) => {
  job(t, 'jobs/on-path.md', 'session.path', ', paths: ["projects/**"]');
  t.repo.commit('job');
  t.accept();
  const s = await openTestSession(t, { actor: 'gardener' });
  const first = await sessionEvent(t.context, s, { kind: 'session.path', vault: 'home', path: 'projects/a.md' });
  assert.equal(first.fresh, true);
  assert.deepEqual(first.spawns.map((e) => [e.document, e.state, e.parent, e.root, e.depth]), [['jobs/on-path.md', 'queued', s.trace, s.trace, 1]]);
  assert.equal(spawnEventKey(first.spawns[0]?.event ?? { kind: 'manual', id: '' }), 'session.path:home:pi-session-1/projects/a.md');
  const again = await sessionEvent(t.context, s, { kind: 'session.path', vault: 'home', path: 'projects/a.md' });
  assert.deepEqual([again.fresh, again.spawns], [false, []]);
  await sessionEvent(t.context, s, { kind: 'session.path', vault: 'home', path: 'notes/b.md' });
  assert.equal(listSpawns(t.context.state).length, 1);
}, { running: RUNNING }));

test('the start and each tool used are session events, identified by the session', withInstallation(async (t) => {
  job(t, 'jobs/on-start.md', 'session.start');
  job(t, 'jobs/on-bash.md', 'session.tool', ', tools: [bash]');
  t.repo.commit('jobs');
  t.accept();
  const s = await openTestSession(t, { actor: 'gardener' });
  const started = await sessionEvent(t.context, s, { kind: 'session.start' });
  assert.deepEqual(started.spawns.map((e) => spawnEventKey(e.event)), ['session.start:pi-session-1']);
  assert.deepEqual((await sessionEvent(t.context, s, { kind: 'session.tool', tool: 'bash' })).spawns.map((e) => e.document), ['jobs/on-bash.md']);
  assert.deepEqual((await sessionEvent(t.context, s, { kind: 'session.tool', tool: 'bash' })).spawns, []);
}, { running: RUNNING }));

test('a request the daemon claimed but whose reply was lost is still one spawn', withInstallation(async (t) => {
  job(t, 'jobs/on-start.md', 'session.start');
  t.repo.commit('job');
  t.accept();
  const s = await openTestSession(t, { actor: 'gardener' });
  const lostReply: SpawnSender = async (request) => {
    enqueueSpawn(t.context.state, { ids: t.context.ids, clock: t.clock, limits: t.installation.config.budgets }, request);
    throw new Error('connection reset');
  };
  const sent = await sessionEvent({ ...t.context, send: lostReply }, s, { kind: 'session.start' });
  assert.equal(sent.spawns.length, 1);
  assert.equal(listSpawns(t.context.state).length, 1);
}, { running: RUNNING }));

test('work spawned from a headless run joins that run\'s tree, one level down', withInstallation(async (t) => {
  job(t, 'jobs/on-path.md', 'session.path', ', paths: ["projects/**"]');
  t.repo.commit('job');
  t.accept();
  const run = startedSpawn(t);
  const s = await openTestSession(t, { run: runOf(run) });
  const spawned = await sessionEvent(t.context, s, { kind: 'session.path', vault: 'home', path: 'projects/a.md' });
  assert.deepEqual(spawned.spawns.map((e) => [e.parent, e.root, e.depth]), [[run.trace, run.trace, 1]]);
}, { running: RUNNING }));

test('a vault with an unaccepted change spawns nothing, and says it is paused', withInstallation(async (t) => {
  job(t, 'jobs/on-start.md', 'session.start');
  t.repo.commit('job');
  t.accept();
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  const s = await openTestSession(t, { actor: 'gardener' });
  const event = await sessionEvent(t.context, s, { kind: 'session.start' });
  assert.deepEqual(event.spawns, []);
  assert.ok(event.notes.some((n) => /"home" is paused/.test(n)), event.notes.join('\n'));
}, { running: RUNNING }));
