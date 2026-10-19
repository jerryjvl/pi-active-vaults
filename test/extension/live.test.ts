// Documented behaviour: concepts.md "Models" — an agent model set to
// `assume-prefix-cache` has each request's prefix read assumed when its engine
// reports no cache reads: the conversation's previous prompt, not counted as
// work again. Without the setting, usage is counted as reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Usage } from '@earendil-works/pi-ai';
import { newPrefixTracker, workTokens } from '../../src/core/budgets/index.ts';
import { workOf } from '../../src/extension/live.ts';

const usage = (input: number, cacheRead = 0): Usage => ({ input, output: 20, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assuming = { role: 'agent' as const, model: 'p/m', assumePrefixCache: true };

test('a request\'s usage is counted as reported unless its model assumes a prefix cache', () => {
  const conversation = newPrefixTracker();
  const plain = { role: 'agent' as const, model: 'p/m' };
  assert.deepEqual([workOf(plain, conversation, usage(1000)), workOf(plain, conversation, usage(1500))].map(workTokens), [1020, 1520]);
  assert.deepEqual([workOf(undefined, conversation, usage(1500))].map(workTokens), [1520], 'a model that is not configured is counted as reported');
});

test('with an assumed prefix cache, a turn counts only what it adds to the conversation, and the trace can tell', () => {
  const conversation = newPrefixTracker();
  const first = workOf(assuming, conversation, usage(1000));
  const second = workOf(assuming, conversation, usage(1500));
  assert.deepEqual([workTokens(first), workTokens(second)], [1020, 520]);
  assert.equal(first.assumedPrefix, undefined);
  assert.deepEqual(second, { prompt: 1500, cachedPrefix: 1000, generated: 20, assumedPrefix: 1000 });
  assert.deepEqual(workOf(assuming, conversation, usage(400, 1200)), { prompt: 1600, cachedPrefix: 1200, generated: 20 }, 'reported cache reads win');
});
