// Documented behaviour: daemon.md "Single instance" — one daemon per machine;
// "Scheduling" — queued spawns run in priority order within the model's
// capacity, one job per actor at a time; "Start-up recovery" — the daemon
// records the exact process of each headless session it starts. concepts.md
// "Actor" — at most one session writes as an actor at once, so an actor an
// interactive session holds waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorsSchema, takeActorHold } from '../../../src/core/actors/index.ts';
import { budgetsSchema, type BudgetLimits } from '../../../src/core/budgets/index.ts';
import { createIdSource } from '../../../src/core/ids/index.ts';
import type { ProcessLiveness } from '../../../src/core/process/index.ts';
import {
  daemonRecord, enqueueSpawn, forgetRunProcess, markAwaited, queueSchema, recordRunProcess, releaseDaemonRecord, runProcesses, schedulable,
  startSpawn, takeDaemonRecord, type SpawnRequest,
} from '../../../src/core/queue/index.ts';
import type { Store } from '../../../src/core/store/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { AGENT_MODELS } from '../../support/models.ts';
import { withStore } from '../../support/store.ts';

const LIMITS: BudgetLimits = { depthDecay: 0.5, maxDepth: 4 };
const running = (processes: Record<number, string>): ProcessLiveness => async (pid) => ({ ok: true, value: processes[pid] });

function queueOf(store: Store) {
  const clock = fakeClock();
  const context = { ids: createIdSource({ clock, randomBytes: (n) => new Uint8Array(n) }), clock, limits: LIMITS, models: AGENT_MODELS };
  let n = 0;
  const claim = (document: string, extra: Partial<SpawnRequest> = {}) => enqueueSpawn(store, context, {
    vault: 'home', document, event: { kind: 'manual', id: `M${++n}` }, budget: { tokens: 100, ttlMs: 60_000 }, actor: 'gardener', ...extra,
  }).entry;
  return { clock, claim };
}

const modules = [actorsSchema, budgetsSchema, queueSchema];

test('one daemon holds the record; another is refused while it runs, and takes over once it has ended', withStore(modules, async (store) => {
  const clock = fakeClock();
  const processes: Record<number, string> = { 10: 'a', 20: 'b' };
  const first = await takeDaemonRecord(store, running(processes), clock, { pid: 10, started: 'a' });
  assert.ok(first.ok);
  const second = await takeDaemonRecord(store, running(processes), clock, { pid: 20, started: 'b' });
  assert.deepEqual(!second.ok && second.error, { reason: 'daemon-running', pid: 10 });
  assert.equal((await daemonRecord(store, running(processes)))?.pid, 10);
  delete processes[10];
  assert.equal(await daemonRecord(store, running(processes)), undefined, 'an ended daemon holds nothing');
  assert.ok((await takeDaemonRecord(store, running(processes), clock, { pid: 20, started: 'b' })).ok);
}));

test('a daemon whose process cannot be told apart still holds the record', withStore(modules, async (store) => {
  const clock = fakeClock();
  assert.ok((await takeDaemonRecord(store, running({ 10: 'a' }), clock, { pid: 10, started: 'a' })).ok);
  const cannotTell: ProcessLiveness = async (pid) => ({ ok: false, error: { reason: 'cannot-tell', pid } });
  assert.equal((await takeDaemonRecord(store, cannotTell, clock, { pid: 20, started: 'b' })).ok, false);
}));

test('a daemon releases only its own record', withStore(modules, async (store) => {
  const clock = fakeClock();
  assert.ok((await takeDaemonRecord(store, running({ 10: 'a' }), clock, { pid: 10, started: 'a' })).ok);
  releaseDaemonRecord(store, { pid: 20, started: 'b' });
  assert.equal((await daemonRecord(store, running({ 10: 'a' })))?.pid, 10);
  releaseDaemonRecord(store, { pid: 10, started: 'a' });
  assert.equal(await daemonRecord(store, running({ 10: 'a' })), undefined);
}));

test('the process of each run the daemon starts is recorded until it is forgotten', withStore(modules, (store) => {
  const { claim } = queueOf(store);
  const spawn = claim('jobs/a.md');
  recordRunProcess(store, spawn.id, { pid: 99, started: 's' });
  assert.deepEqual(runProcesses(store), [{ spawn: spawn.id, pid: 99, started: 's' }]);
  forgetRunProcess(store, spawn.id);
  assert.deepEqual(runProcesses(store), []);
}));

test('queued spawns are scheduled in priority order, within capacity', withStore(modules, async (store) => {
  const { claim } = queueOf(store);
  const a = claim('jobs/a.md', { actor: 'gardener' });
  const b = claim('jobs/b.md', { actor: 'librarian' });
  const c = claim('jobs/c.md', { actor: 'archivist' });
  assert.ok(markAwaited(store, c.id).ok);
  assert.deepEqual((await schedulable(store, running({}), 2)).map((s) => s.document), ['jobs/c.md', 'jobs/a.md'], 'awaited work first');
  assert.ok(startSpawn(store, fakeClock(), a.id).ok);
  assert.deepEqual((await schedulable(store, running({}), 2)).map((s) => s.document), ['jobs/c.md'], 'one place is taken');
  void b;
}));

test('one job per actor at a time: a second waits while the first runs or is queued ahead of it', withStore(modules, async (store) => {
  const { claim, clock } = queueOf(store);
  const first = claim('jobs/a.md');
  claim('jobs/b.md');
  claim('jobs/c.md', { actor: 'librarian' });
  assert.deepEqual((await schedulable(store, running({}), 5)).map((s) => s.document), ['jobs/a.md', 'jobs/c.md']);
  assert.ok(startSpawn(store, clock, first.id).ok);
  assert.deepEqual((await schedulable(store, running({}), 5)).map((s) => s.document), ['jobs/c.md']);
}));

test('an actor an interactive session holds waits for it; a spawn with no actor is never scheduled', withStore(modules, async (store) => {
  const { claim, clock } = queueOf(store);
  claim('jobs/a.md');
  const alive = running({ 7: 's' });
  assert.ok((await takeActorHold(store, alive, clock, { vault: 'home', actor: 'gardener', holder: { process: { pid: 7, started: 's' }, session: 'pi' } })).ok);
  assert.deepEqual(await schedulable(store, alive, 5), []);
  assert.deepEqual((await schedulable(store, running({}), 5)).map((s) => s.document), ['jobs/a.md'], 'free once that session has ended');
  store.run("UPDATE queue_spawns SET actor = NULL");
  assert.deepEqual(await schedulable(store, running({}), 5), []);
}));
