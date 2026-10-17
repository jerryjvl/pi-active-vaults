// Documented behaviour: concepts.md "Document" and "Session tree", principle 7
// — a document that can spawn work carries `budget: { tokens, ttl }`; a spawned
// session receives the smaller of its document's budget and its allotment from
// the root's cascade pool (the pool's remaining tokens × depth-decay per level
// × the trigger's relevance, 1 when it has none); budgets only shrink as work
// branches; tokens are counted as work (prompt and generated tokens, excluding
// cached-prefix reads); ttl is run time; no document fires twice in one tree,
// backed by max-depth; and the installation's daily ceiling bounds all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountUsage,
  allot,
  budgetState,
  budgetsSchema,
  finishSession,
  parseBudget,
  startSession,
  workTokens,
  type AllotRequest,
  type BudgetLimits,
} from '../../../src/core/budgets/index.ts';
import { STATE_FILE, openStore, type Store } from '../../../src/core/store/index.ts';
import { fakeClock, type FakeClock } from '../../support/clock.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const LIMITS: BudgetLimits = { cascadePool: 300_000, depthDecay: 0.5, maxDepth: 4 };
const BIG = { tokens: 1_000_000, ttlMs: 60_000 };

function withBudgets(run: (store: Store, clock: FakeClock) => void): () => Promise<void> {
  return withTempDir((dir) => {
    const opened = openStore(dir.file('state.sqlite'), STATE_FILE, [budgetsSchema]);
    assert.ok(opened.ok);
    try {
      run(opened.value, fakeClock());
    } finally {
      opened.value.close();
    }
  });
}

function allotIn(store: Store, clock: FakeClock, request: AllotRequest, limits: BudgetLimits = LIMITS) {
  return store.transaction((tx) => allot(tx, limits, clock, request));
}

function allotted(store: Store, clock: FakeClock, request: AllotRequest, limits?: BudgetLimits): number {
  const result = allotIn(store, clock, request, limits);
  if (!result.ok) assert.fail(`expected an allotment: ${JSON.stringify(result.error)}`);
  return result.value.tokens;
}

const job = (trace: string, document: string, extra: Partial<AllotRequest> = {}): AllotRequest =>
  ({ trace, vault: 'home', document, budget: BIG, ...extra });

test('a budget is tokens and a run time; anything else is refused with every problem', () => {
  assert.deepEqual(parseBudget({ tokens: 50_000, ttl: '30m' }), { ok: true, value: { tokens: 50_000, ttlMs: 30 * 60_000 } });
  assert.deepEqual(parseBudget({ tokens: 1, ttl: '90s' }), { ok: true, value: { tokens: 1, ttlMs: 90_000 } });
  assert.deepEqual(parseBudget({ tokens: 1, ttl: '2h' }), { ok: true, value: { tokens: 1, ttlMs: 2 * 3_600_000 } });
  const missing = parseBudget(undefined);
  assert.deepEqual(!missing.ok && missing.error.map((i) => i.path), ['budget']);
  const bad = parseBudget({ tokens: 0, ttl: '30', extra: true });
  assert.deepEqual(!bad.ok && bad.error.map((i) => i.path).sort(), ['budget.extra', 'budget.tokens', 'budget.ttl']);
  for (const ttl of ['0m', '1d', '1.5h', 30, '-5m']) assert.equal(parseBudget({ tokens: 1, ttl }).ok, false, String(ttl));
});

test('work tokens are prompt and generated tokens, excluding cached-prefix reads', () => {
  assert.equal(workTokens({ prompt: 1000, cachedPrefix: 800, generated: 50 }), 250);
  assert.equal(workTokens({ prompt: 100, cachedPrefix: 0, generated: 0 }), 100);
});

test('a root session gets its document\'s budget, and its tree gets the cascade pool', withBudgets((store, clock) => {
  assert.equal(allotted(store, clock, job('R', 'jobs/root.md', { budget: { tokens: 40_000, ttlMs: 60_000 } })), 40_000);
  // A child at depth 1 gets the smaller of its budget and pool × 0.5.
  assert.equal(allotted(store, clock, job('C1', 'jobs/a.md', { parent: 'R', budget: { tokens: 1000, ttlMs: 1 } })), 1000);
  assert.equal(allotted(store, clock, job('C2', 'jobs/b.md', { parent: 'R' })), Math.floor((300_000 - 1000) * 0.5));
}));

test('allotments shrink with depth and relevance, and what is allotted is reserved from the pool until used', withBudgets((store, clock) => {
  allotted(store, clock, job('R', 'jobs/root.md'));
  const first = allotted(store, clock, job('A', 'jobs/a.md', { parent: 'R' }));
  assert.equal(first, 150_000);
  const second = allotted(store, clock, job('B', 'jobs/b.md', { parent: 'R', relevance: 0.2 }));
  assert.equal(second, Math.floor(150_000 * 0.5 * 0.2));
  const deeper = allotted(store, clock, job('A1', 'jobs/c.md', { parent: 'A' }));
  assert.equal(deeper, Math.floor((300_000 - 150_000 - 15_000) * 0.25));
  // Once A finishes having used little, the rest of its allotment returns to the pool.
  store.transaction((tx) => {
    assert.ok(startSession(tx, clock, 'A').ok);
    assert.ok(accountUsage(tx, LIMITS, clock, 'A', { prompt: 10_000, cachedPrefix: 0, generated: 0 }).ok);
    assert.ok(finishSession(tx, clock, 'A').ok);
  });
  assert.equal(allotted(store, clock, job('D', 'jobs/d.md', { parent: 'R' })), Math.floor((300_000 - 10_000 - 15_000 - deeper) * 0.5));
}));

test('no document fires twice in one tree, though another tree may run it', withBudgets((store, clock) => {
  allotted(store, clock, job('R', 'jobs/root.md'));
  allotted(store, clock, job('A', 'jobs/a.md', { parent: 'R' }));
  const again = allotIn(store, clock, job('A2', 'jobs/a.md', { parent: 'A' }));
  assert.deepEqual(!again.ok && again.error, { reason: 'already-in-tree', vault: 'home', document: 'jobs/a.md' });
  const root = allotIn(store, clock, job('R2', 'jobs/root.md', { parent: 'A' }));
  assert.equal(!root.ok && root.error.reason, 'already-in-tree');
  assert.ok(allotIn(store, clock, job('S', 'jobs/a.md')).ok, 'a new tree');
}));

test('a spawn deeper than max-depth is refused', withBudgets((store, clock) => {
  const limits = { ...LIMITS, maxDepth: 2 };
  allotted(store, clock, job('R', 'r.md'), limits);
  allotted(store, clock, job('D1', 'd1.md', { parent: 'R' }), limits);
  allotted(store, clock, job('D2', 'd2.md', { parent: 'D1' }), limits);
  const tooDeep = allotIn(store, clock, job('D3', 'd3.md', { parent: 'D2' }), limits);
  assert.deepEqual(!tooDeep.ok && tooDeep.error, { reason: 'too-deep', depth: 3, maxDepth: 2 });
}));

test('an exhausted pool, an unknown parent and an invalid relevance are refused', withBudgets((store, clock) => {
  const tiny = { ...LIMITS, cascadePool: 3 };
  allotted(store, clock, job('R', 'r.md'), tiny);
  assert.equal(allotted(store, clock, job('A', 'a.md', { parent: 'R' }), tiny), 1);
  allotted(store, clock, job('B', 'b.md', { parent: 'R' }), tiny);
  const dry = allotIn(store, clock, job('C', 'c.md', { parent: 'R' }), tiny);
  assert.deepEqual(!dry.ok && dry.error, { reason: 'pool-exhausted' });
  const orphan = allotIn(store, clock, job('O', 'o.md', { parent: 'NOPE' }));
  assert.deepEqual(!orphan.ok && orphan.error, { reason: 'unknown-parent', parent: 'NOPE' });
  assert.throws(() => allotIn(store, clock, job('X', 'x.md', { parent: 'R', relevance: 1.5 })), /relevance/);
}));

test('without a configured cascade pool, depth, once-per-tree and the daily ceiling still bound the tree', withBudgets((store, clock) => {
  const noPool = { depthDecay: 0.5, maxDepth: 4 };
  allotted(store, clock, job('R', 'r.md'), noPool);
  assert.equal(allotted(store, clock, job('A', 'a.md', { parent: 'R', budget: { tokens: 5000, ttlMs: 1 } }), noPool), 5000);
}));

test('the daily ceiling caps allotments, refuses new work once reached, and resets the next UTC day', withBudgets((store, clock) => {
  const daily = { ...LIMITS, dailyTokens: 100_000 };
  assert.equal(allotted(store, clock, job('R', 'r.md'), daily), 100_000);
  store.transaction((tx) => {
    startSession(tx, clock, 'R');
    const state = accountUsage(tx, daily, clock, 'R', { prompt: 99_000, cachedPrefix: 0, generated: 2000 });
    assert.ok(state.ok);
    assert.deepEqual([state.value.used, state.value.exhausted, state.value.dailyExhausted], [101_000, true, true]);
  });
  const refused = allotIn(store, clock, job('S', 's.md'), daily);
  assert.deepEqual(!refused.ok && refused.error, { reason: 'daily-exhausted' });
  clock.advance(24 * 60 * 60 * 1000);
  assert.ok(allotIn(store, clock, job('T', 't.md'), daily).ok);
}));

test('usage is accounted against the session; ttl counts from the start of the run', withBudgets((store, clock) => {
  allotted(store, clock, job('R', 'r.md', { budget: { tokens: 1000, ttlMs: 60_000 } }));
  assert.equal(budgetState(store, LIMITS, clock, 'R')?.overTime, false, 'queue time is not run time');
  clock.advance(120_000);
  store.transaction((tx) => assert.ok(startSession(tx, clock, 'R').ok));
  store.transaction((tx) => {
    const state = accountUsage(tx, LIMITS, clock, 'R', { prompt: 700, cachedPrefix: 200, generated: 100 });
    assert.ok(state.ok);
    assert.deepEqual([state.value.used, state.value.remaining, state.value.exhausted], [600, 400, false]);
  });
  clock.advance(59_000);
  assert.equal(budgetState(store, LIMITS, clock, 'R')?.overTime, false);
  clock.advance(2000);
  const late = budgetState(store, LIMITS, clock, 'R');
  assert.equal(late?.overTime, true);
  assert.equal(late?.deadline, '2026-01-01T00:03:00.000Z');
}));

test('accounting for an unknown or finished session is refused', withBudgets((store, clock) => {
  allotted(store, clock, job('R', 'r.md'));
  store.transaction((tx) => {
    const unknown = accountUsage(tx, LIMITS, clock, 'NOPE', { prompt: 1, cachedPrefix: 0, generated: 0 });
    assert.deepEqual(!unknown.ok && unknown.error, { reason: 'unknown-session', trace: 'NOPE' });
    assert.ok(finishSession(tx, clock, 'R').ok);
    const finished = accountUsage(tx, LIMITS, clock, 'R', { prompt: 1, cachedPrefix: 0, generated: 0 });
    assert.deepEqual(!finished.ok && finished.error, { reason: 'finished', trace: 'R' });
  });
  assert.equal(budgetState(store, LIMITS, clock, 'NOPE'), undefined);
}));
