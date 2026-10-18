// Documented behaviour: daemon.md "Socket protocol" — `ping` (version and
// capabilities), `spawn` (submit a spawn request), `status` (queue, running
// sessions, budgets), `subscribe` (start and finish notices for a session's
// spawns), `stop` (stop a running spawn). A spawn request is claimed under
// its identity, with its budget and actor as the job on the accepted main
// has them — never as the request says; one that matches no job's spawn
// condition, or is for a paused vault, is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allot } from '../../../src/core/budgets/index.ts';
import { listSpawns } from '../../../src/core/queue/index.ts';
import { automationFor, fakePi, jobDocument } from '../../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';

const ROOT = '01JR00T0000000000000000000';
const request = (extra: Record<string, unknown> = {}) => ({
  vault: 'home', document: 'jobs/a.md', condition: 0, event: { kind: 'external', vault: 'home', name: 'go', id: 'E1' },
  budget: { tokens: 999_999_999, ttlMs: 999_999_999 }, actor: 'alice', ...extra,
});

function job(t: TestInstallation): void {
  t.repo.write('jobs/a.md', jobDocument('[{ on: external, name: go, effect: spawn }]', { tokens: 1234 }));
  t.accept(t.repo.commit('job'));
}

test('ping answers the version and the methods', withInstallation(async (t) => {
  const answer = await automationFor(t, fakePi(t)).handle({ method: 'ping', params: {} }, () => {});
  assert.deepEqual(answer, { ok: true, result: { version: '0.0.0-test', capabilities: ['ping', 'spawn', 'status', 'subscribe', 'stop'] } });
}));

test('a spawn request is claimed with the budget and actor of the job on the accepted main, not the request\'s', withInstallation(async (t) => {
  job(t);
  const automation = automationFor(t, fakePi(t));
  const answer = await automation.handle({ method: 'spawn', params: request() }, () => {});
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const [spawn] = listSpawns(t.context.state);
  assert.deepEqual([spawn?.document, spawn?.actor, spawn?.tokens, spawn?.state], ['jobs/a.md', 'gardener', 1234, 'queued']);
  const again = await automation.handle({ method: 'spawn', params: request() }, () => {});
  assert.equal(again.ok && (again.result as { trace: string }).trace, spawn?.trace, 'the same identity is the same spawn');
}));

test('a request that is no job\'s spawn condition, or for a paused vault, is refused and nothing is claimed', withInstallation(async (t) => {
  job(t);
  const automation = automationFor(t, fakePi(t));
  const reasons = [];
  for (const params of [
    request({ document: 'jobs/none.md' }),
    request({ condition: 3 }),
    request({ event: { kind: 'external', vault: 'home', name: 'other', id: 'E2' } }),
    request({ vault: 'nowhere' }),
    { vault: 'home' },
  ]) {
    const answer = await automation.handle({ method: 'spawn', params }, () => {});
    reasons.push(!answer.ok && answer.error.reason);
  }
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  const paused = await automation.handle({ method: 'spawn', params: request() }, () => {});
  reasons.push(!paused.ok && paused.error.reason);
  assert.deepEqual(reasons, ['not-a-job', 'not-matched', 'not-matched', 'unknown-vault', 'invalid-request', 'unaccepted-change']);
  assert.deepEqual(listSpawns(t.context.state), []);
}));

test('status shows the queue, what runs and the day\'s budget', withInstallation(async (t) => {
  job(t);
  const automation = automationFor(t, fakePi(t));
  await automation.handle({ method: 'spawn', params: request() }, () => {});
  const answer = await automation.handle({ method: 'status', params: {} }, () => {});
  assert.ok(answer.ok);
  const status = answer.result as { queued: { document: string }[]; running: unknown[]; budgets: { dailyUsed: number; dailyTokens?: number } };
  assert.deepEqual(status.queued.map((q) => q.document), ['jobs/a.md']);
  assert.deepEqual(status.running, []);
  assert.deepEqual(status.budgets, { dailyUsed: 0, dailyTokens: 50_000 });
}, { config: 'budgets: { daily-tokens: 50000 }' }));

test('a subscriber is told when the spawns of its session start and finish', withInstallation(async (t) => {
  job(t);
  t.context.state.transaction((tx) => allot(tx, t.installation.config.budgets, t.clock, { trace: ROOT, budget: { tokens: 1_000_000, ttlMs: 0 } }));
  const automation = automationFor(t, fakePi(t, { '*': 'nothing' }));
  const mine: unknown[] = [];
  const others: unknown[] = [];
  await automation.handle({ method: 'subscribe', params: { trace: ROOT } }, (n) => mine.push(n));
  await automation.handle({ method: 'subscribe', params: { trace: '01JOTHER00000000000000000' } }, (n) => others.push(n));
  await automation.handle({ method: 'spawn', params: request({ parent: ROOT }) }, () => {});
  await automation.schedule();
  await automation.idle();
  assert.deepEqual(mine.map((n) => [(n as { state: string }).state, (n as { document: string }).document]), [['started', 'jobs/a.md'], ['finished', 'jobs/a.md']]);
  assert.deepEqual(others, []);
}));

test('stop ends a running spawn, which is stopped on request', withInstallation(async (t) => {
  job(t);
  const automation = automationFor(t, fakePi(t, { '*': 'hang' }));
  await automation.handle({ method: 'spawn', params: request() }, () => {});
  await automation.schedule();
  const [running] = listSpawns(t.context.state);
  const answer = await automation.handle({ method: 'stop', params: { trace: running?.trace } }, () => {});
  assert.equal(answer.ok, true, JSON.stringify(answer));
  await automation.idle();
  assert.deepEqual(listSpawns(t.context.state).map((s) => s.reason), ['requested']);
  const missing = await automation.handle({ method: 'stop', params: { trace: running?.trace } }, () => {});
  assert.deepEqual(!missing.ok && missing.error.reason, 'not-running');
}));

test('an unknown method or a malformed request is refused with why', withInstallation(async (t) => {
  const automation = automationFor(t, fakePi(t));
  assert.deepEqual(await automation.handle({ method: 'accept', params: {} }, () => {}), { ok: false, error: { reason: 'unknown-method', method: 'accept' } });
  assert.deepEqual(await automation.handle('nonsense', () => {}), { ok: false, error: { reason: 'invalid-request' } });
}));
