// Documented behaviour: extension.md "Session lifecycle" (`turn_end`) and
// concepts.md "Session tree" — each turn's tokens are recorded against the
// session's budget as the turn ends, so a crash loses at most the turn in
// progress; work is prompt and generated tokens excluding cached-prefix
// reads; a headless run stops at its budget, its run time or the daily
// ceiling (principle 7). An interactive session is the person's: its work
// counts towards the day, but it is not stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetState, usageOf } from '../../../src/core/budgets/index.ts';
import { recordTurn, workLeft } from '../../../src/core/sessions/index.ts';
import { withInstallation } from '../../support/installation.ts';
import { RUNNING, openTestSession, runOf, startedSpawn } from '../../support/session.ts';

const turn = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => usageOf({ input, output, cacheRead, cacheWrite });

test('a model\'s usage counts as work all but its cached-prefix reads', () => {
  assert.deepEqual(usageOf({ input: 100, output: 20, cacheRead: 1000, cacheWrite: 50 }), { prompt: 1150, cachedPrefix: 1000, generated: 20 });
});

test('each turn is recorded as it ends', withInstallation(async (t) => {
  const s = await openTestSession(t, { actor: 'gardener' });
  assert.deepEqual(recordTurn(t.context, s, [turn(100, 20, 1000), turn(10, 5)]).stop, undefined);
  assert.equal(budgetState(t.context.state, t.installation.config.budgets, t.clock, s.trace)?.used, 135);
  recordTurn(t.context, s, [turn(1, 1)]);
  assert.equal(budgetState(t.context.state, t.installation.config.budgets, t.clock, s.trace)?.used, 137);
}, { running: RUNNING }));

test('a headless run stops once its budget is used', withInstallation(async (t) => {
  const s = await openTestSession(t, { run: runOf(startedSpawn(t, 'jobs/daily.md', 500)) });
  assert.equal(recordTurn(t.context, s, [turn(300, 100)]).stop, undefined);
  assert.equal(recordTurn(t.context, s, [turn(100, 50)]).stop, 'budget');
}, { running: RUNNING }));

test('a headless run stops past its run time', withInstallation(async (t) => {
  const s = await openTestSession(t, { run: runOf(startedSpawn(t)) });
  t.clock.advance(600_001);
  assert.equal(recordTurn(t.context, s, [turn(1, 1)]).stop, 'ttl');
}, { running: RUNNING }));

test('the daily ceiling stops a headless run but not an interactive session', withInstallation(async (t) => {
  const run = await openTestSession(t, { run: runOf(startedSpawn(t, 'jobs/daily.md', 900)) });
  const person = await openTestSession(t, { session: 'pi-session-2', actor: 'alice' });
  assert.equal(recordTurn(t.context, person, [turn(1000, 0)]).stop, undefined, 'the person is not stopped');
  assert.equal(recordTurn(t.context, run, [turn(10, 0)]).stop, 'budget');
}, { running: RUNNING, config: 'budgets: { daily-tokens: 1000 }' }));

test('a headless run knows how much work it has left; an interactive session is not bounded by it', withInstallation(async (t) => {
  const run = await openTestSession(t, { run: runOf(startedSpawn(t, 'jobs/daily.md', 500)) });
  assert.equal(workLeft(t.context, run), 500);
  recordTurn(t.context, run, [turn(100, 50)]);
  assert.equal(workLeft(t.context, run), 350);
  t.clock.advance(600_001);
  assert.equal(workLeft(t.context, run), 0, 'past its run time, nothing is left');
  const person = await openTestSession(t, { session: 'pi-session-2', actor: 'alice' });
  assert.equal(workLeft(t.context, person), undefined);
}, { running: RUNNING }));
