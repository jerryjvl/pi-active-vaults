// Documented behaviour: daemon.md "Spawn lifecycle" and "Claims",
// architecture.md "Local storage" and "Scheduling", core.md `enqueueSpawn` — a
// spawn's identity is its document and the event that triggered it; the claim
// is a unique insert recorded before anything runs, and a second claim for the
// same identity yields the existing one; each state change is one transaction,
// so a crash leaves every spawn in exactly one state; queued work is ordered
// by: work another session waits on, a trigger's original work before the
// follow-ups it caused, earlier roots before later ones; queue time has its
// own limit; spawned work gets its budget from the session tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountUsage, budgetState, budgetsSchema, type BudgetLimits } from '../../../src/core/budgets/index.ts';
import type { GitEvent } from '../../../src/core/conditions/index.ts';
import { createIdSource, type IdSource } from '../../../src/core/ids/index.ts';
import {
  commitSpawn,
  enqueueSpawn,
  expireQueued,
  listSpawns,
  markAwaited,
  nextSpawns,
  noChangeSpawn,
  queueSchema,
  recordSpawn,
  spawnEventKey,
  startSpawn,
  stopSpawn,
  type SpawnRequest,
} from '../../../src/core/queue/index.ts';
import { STATE_FILE, openStore, type Store } from '../../../src/core/store/index.ts';
import { fakeClock, type FakeClock } from '../../support/clock.ts';
import { withStore } from '../../support/store.ts';
import type { TempDir } from '../../support/temp-dir.ts';

const LIMITS: BudgetLimits = { cascadePool: 300_000, depthDecay: 0.5, maxDepth: 4 };
const BUDGET = { tokens: 50_000, ttlMs: 600_000 };

interface Queue {
  readonly store: Store;
  readonly clock: FakeClock;
  readonly context: { ids: IdSource; clock: FakeClock; limits: BudgetLimits };
  readonly dir: TempDir;
}

function withQueue(run: (q: Queue) => void): () => Promise<void> {
  return withStore([budgetsSchema, queueSchema], (store, dir) => {
    const clock = fakeClock();
    run({ store, clock, context: { ids: createIdSource({ clock, randomBytes: (n) => new Uint8Array(n) }), clock, limits: LIMITS }, dir });
  });
}

const merged = (commit: string, vault = 'home'): GitEvent => ({ kind: 'merged', vault, commit, changes: [] });

const request = (document: string, extra: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ vault: 'home', document, condition: 0, event: merged('a'.repeat(40)), budget: BUDGET, actor: 'gardener', ...extra });

test('a spawn is claimed once per document and event; a second claim yields the existing one', withQueue(({ store, context }) => {
  const first = enqueueSpawn(store, context, request('jobs/digest.md'));
  assert.equal(first.claimed, true);
  assert.equal(first.entry.state, 'queued');
  const again = enqueueSpawn(store, context, request('jobs/digest.md', { condition: 1 }));
  assert.equal(again.claimed, false, 'another condition of the same document matching the same event');
  assert.deepEqual(again.entry, first.entry);
  assert.equal(listSpawns(store).length, 1);
  // A different event, or the same commit seen as another vault's event, is a different spawn.
  assert.equal(enqueueSpawn(store, context, request('jobs/digest.md', { event: merged('b'.repeat(40)) })).claimed, true);
  assert.equal(enqueueSpawn(store, context, request('jobs/digest.md', { event: merged('a'.repeat(40), 'other') })).claimed, true);
  assert.equal(enqueueSpawn(store, context, request('jobs/other.md')).claimed, true);
}));

test('a claim made through another connection to the same file is seen, never duplicated', withQueue(({ store, context, dir }) => {
  const second = openStore(dir.file('store.sqlite'), STATE_FILE, [budgetsSchema, queueSchema]);
  assert.ok(second.ok);
  try {
    const mine = enqueueSpawn(store, context, request('jobs/digest.md'));
    const theirs = enqueueSpawn(second.value, context, request('jobs/digest.md'));
    assert.equal(theirs.claimed, false);
    assert.equal(theirs.entry.id, mine.entry.id);
  } finally {
    second.value.close();
  }
}));

test('a queued spawn carries its own trace, its place in the session tree and its allotted budget', withQueue(({ store, context }) => {
  const root = enqueueSpawn(store, context, request('jobs/root.md')).entry;
  assert.deepEqual([root.parent, root.root, root.depth, root.tokens], [undefined, root.trace, 0, 50_000]);
  const child = enqueueSpawn(store, context, request('jobs/child.md', { parent: root.trace, budget: { tokens: 1_000_000, ttlMs: 1 } })).entry;
  assert.notEqual(child.trace, root.trace);
  assert.deepEqual([child.parent, child.root, child.depth, child.tokens], [root.trace, root.trace, 1, 150_000]);
  assert.deepEqual(child.event, merged('a'.repeat(40)));
  assert.equal(budgetState(store, LIMITS, context.clock, child.trace)?.allotted, 150_000);
}));

test('a spawn the session tree refuses is still claimed, and recorded as stopped with the reason', withQueue(({ store, context }) => {
  const root = enqueueSpawn(store, context, request('jobs/root.md')).entry;
  const loop = enqueueSpawn(store, context, request('jobs/root.md', { parent: root.trace, event: merged('c'.repeat(40)) }));
  assert.deepEqual([loop.claimed, loop.entry.state, loop.entry.reason], [true, 'stopped', 'already-in-tree']);
  const again = enqueueSpawn(store, context, request('jobs/root.md', { parent: root.trace, event: merged('c'.repeat(40)) }));
  assert.deepEqual([again.claimed, again.entry.id], [false, loop.entry.id]);
}));

test('a claim is all or nothing: if allotting fails, nothing is claimed', withQueue(({ store, context }) => {
  const root = enqueueSpawn(store, context, request('jobs/root.md')).entry;
  assert.throws(() => enqueueSpawn(store, context, request('jobs/child.md', { parent: root.trace, relevance: 7 })), /relevance/);
  assert.equal(listSpawns(store).length, 1);
}));

test('a spawn runs, commits and is recorded; each step only from the state before it', withQueue(({ store, context, clock }) => {
  const { entry } = enqueueSpawn(store, context, request('jobs/digest.md'));
  const early = commitSpawn(store, clock, entry.id, 'f'.repeat(40));
  assert.deepEqual(!early.ok && early.error, { reason: 'wrong-state', id: entry.id, state: 'queued' });
  clock.advance(1000);
  const running = startSpawn(store, clock, entry.id);
  assert.ok(running.ok);
  assert.deepEqual([running.value.state, running.value.started], ['running', '2026-01-01T00:00:01.000Z']);
  assert.equal(budgetState(store, LIMITS, clock, entry.trace)?.deadline, '2026-01-01T00:10:01.000Z', 'ttl counts from the start');
  assert.equal(startSpawn(store, clock, entry.id).ok, false);
  const committed = commitSpawn(store, clock, entry.id, 'f'.repeat(40));
  assert.ok(committed.ok);
  assert.deepEqual([committed.value.state, committed.value.commit], ['committed', 'f'.repeat(40)]);
  const recorded = recordSpawn(store, entry.id);
  assert.ok(recorded.ok && recorded.value.state === 'recorded');
  assert.equal(stopSpawn(store, clock, entry.id, 'error').ok, false, 'a recorded spawn is final');
  const missing = startSpawn(store, clock, 999);
  assert.deepEqual(!missing.ok && missing.error, { reason: 'not-found', id: 999 });
}));

test('a spawn stops from the queue or while running; stopping ends its session, returning unused budget', withQueue(({ store, context, clock }) => {
  const root = enqueueSpawn(store, context, request('jobs/root.md')).entry;
  const child = enqueueSpawn(store, context, request('jobs/child.md', { parent: root.trace, budget: { tokens: 1_000_000, ttlMs: 1 } })).entry;
  assert.ok(startSpawn(store, clock, child.id).ok);
  const stopped = stopSpawn(store, clock, child.id, 'ttl');
  assert.ok(stopped.ok);
  assert.deepEqual([stopped.value.state, stopped.value.reason], ['stopped', 'ttl']);
  const sibling = enqueueSpawn(store, context, request('jobs/sibling.md', { parent: root.trace, budget: { tokens: 1_000_000, ttlMs: 1 } })).entry;
  assert.equal(sibling.tokens, 150_000, 'the stopped spawn used nothing, so the whole pool is back');
  const queued = stopSpawn(store, clock, sibling.id, 'budget');
  assert.ok(queued.ok && queued.value.state === 'stopped');
  assert.ok(recordSpawn(store, sibling.id).ok);
}));

test('queued spawns come in order: awaited work, then shallower work, then earlier roots, then claim order', withQueue(({ store, context, clock }) => {
  const rootA = enqueueSpawn(store, context, request('a.md')).entry;
  clock.advance(10);
  const rootB = enqueueSpawn(store, context, request('b.md')).entry;
  const a1 = enqueueSpawn(store, context, request('a1.md', { parent: rootA.trace })).entry;
  const b1 = enqueueSpawn(store, context, request('b1.md', { parent: rootB.trace })).entry;
  const a2 = enqueueSpawn(store, context, request('a2.md', { parent: a1.trace })).entry;
  const b2 = enqueueSpawn(store, context, request('b2.md', { parent: b1.trace })).entry;
  assert.deepEqual(nextSpawns(store, 10).map((e) => e.document), ['a.md', 'b.md', 'a1.md', 'b1.md', 'a2.md', 'b2.md']);
  assert.ok(markAwaited(store, b2.id).ok);
  assert.ok(startSpawn(store, clock, rootA.id).ok);
  assert.deepEqual(nextSpawns(store, 3).map((e) => e.document), ['b2.md', 'b.md', 'a1.md']);
  assert.equal(a2.state, 'queued');
}));

test('queue time has its own limit: spawns queued too long are stopped, running ones are not', withQueue(({ store, context, clock }) => {
  const old = enqueueSpawn(store, context, request('old.md')).entry;
  const running = enqueueSpawn(store, context, request('running.md')).entry;
  assert.ok(startSpawn(store, clock, running.id).ok);
  clock.advance(50_000);
  const fresh = enqueueSpawn(store, context, request('fresh.md')).entry;
  clock.advance(20_000);
  const expired = expireQueued(store, clock, 60_000);
  assert.deepEqual(expired.map((e) => [e.document, e.state, e.reason]), [['old.md', 'stopped', 'queue-time']]);
  assert.deepEqual(listSpawns(store).map((e) => [e.id, e.state]), [[old.id, 'stopped'], [running.id, 'running'], [fresh.id, 'queued']]);
}));

test('event identities: Git events by vault and commit, timers by their scheduled time, others by their own ID', () => {
  assert.equal(spawnEventKey(merged('a'.repeat(40))), `merged:home:${'a'.repeat(40)}`);
  assert.equal(spawnEventKey({ kind: 'committed', vault: 'v', commit: 'b'.repeat(40), changes: [] }), `committed:v:${'b'.repeat(40)}`);
  assert.equal(spawnEventKey({ kind: 'timer', at: '2026-01-01T06:30:00.000Z' }), 'timer:2026-01-01T06:30:00.000Z');
  assert.equal(spawnEventKey({ kind: 'external', vault: 'home', name: 'deploy', id: 'E1' }), 'external:home:E1');
  assert.equal(spawnEventKey({ kind: 'session.tool', tool: 'bash', id: 'S1-7' }), 'session.tool:S1-7');
  assert.equal(spawnEventKey({ kind: 'manual', id: 'R1' }), 'manual:R1');
});

test('a run that ends without changes is recorded as no-change, ending its session; only a running spawn can', withQueue(({ store, context, clock }) => {
  const { entry } = enqueueSpawn(store, context, request('jobs/maybe.md'));
  const early = noChangeSpawn(store, clock, entry.id);
  assert.deepEqual(!early.ok && early.error, { reason: 'wrong-state', id: entry.id, state: 'queued' });
  assert.ok(startSpawn(store, clock, entry.id).ok);
  clock.advance(5000);
  const ended = noChangeSpawn(store, clock, entry.id);
  assert.ok(ended.ok);
  assert.deepEqual([ended.value.state, ended.value.commit, ended.value.ended], ['no-change', undefined, '2026-01-01T00:00:05.000Z']);
  assert.equal(accountUsage(store, LIMITS, clock, entry.trace, { prompt: 1, cachedPrefix: 0, generated: 0 }).ok, false, 'its budget session has ended');
  assert.equal(stopSpawn(store, clock, entry.id, 'error').ok, false);
  assert.ok(recordSpawn(store, entry.id).ok);
}));

test('a running spawn the daemon finds left over from before a restart stops with the reason restart', withQueue(({ store, context, clock }) => {
  const { entry } = enqueueSpawn(store, context, request('jobs/long.md'));
  assert.ok(startSpawn(store, clock, entry.id).ok);
  const stopped = stopSpawn(store, clock, entry.id, 'restart');
  assert.ok(stopped.ok);
  assert.deepEqual([stopped.value.state, stopped.value.reason], ['stopped', 'restart']);
}));
