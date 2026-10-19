// Documented behaviour: concepts.md "Models", core.md `models`, principle 10 —
// a request names a model and never guarantees one: a name that is not
// configured is answered by the role's default (marked as substituted); a
// name configured with another role is refused; a configured model the
// installation's `policy` does not allow for a vault is never replaced by the
// default; a missing default disables the feature without an error. Policy is
// checked on the model actually used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InstallationConfig, ModelEntry } from '../../../src/core/config/index.ts';
import { resolveModel } from '../../../src/core/models/index.ts';

const http = (role: 'judgement' | 'embed' | 'rerank', model: string): ModelEntry => (
  { role, url: 'http://127.0.0.1:1/v1', token: { kind: 'env', name: 'T', where: 'models.x.token' }, model, batch: 1, parallel: 1 }
);

const models: InstallationConfig['models'] = {
  judgement: http('judgement', 'strong'),
  classify: http('judgement', 'fast'),
  agent: { role: 'agent', model: 'homeserver/big' },
  quick: { role: 'agent', model: 'homeserver/small' },
  embed: http('embed', 'embedder'),
};
const allowing = (...names: string[]): InstallationConfig['policy'] => [{ vaults: ['home', 'work'], allowModels: names }];
const config = (policy: InstallationConfig['policy'], entries = models): Pick<InstallationConfig, 'models' | 'policy'> => ({ models: entries, policy });

test('without a request the role\'s default answers, and it is not a substitution', () => {
  const found = resolveModel(config(allowing('judgement', 'agent')), 'judgement', ['home']);
  assert.ok(found.ok);
  assert.equal(found.value.name, 'judgement');
  assert.equal(found.value.substitutedFor, undefined);
  assert.equal(found.value.entry.model, 'strong');
  assert.deepEqual(found.value.vaults, ['home']);
  const agent = resolveModel(config(allowing('agent')), 'agent', ['home']);
  assert.ok(agent.ok);
  assert.equal(agent.value.entry.model, 'homeserver/big');
});

test('a requested name that is configured with the role answers, wherever the default is', () => {
  const found = resolveModel(config(allowing('classify')), 'judgement', ['home'], 'classify');
  assert.ok(found.ok, 'the default need not be allowed when it is not the model used');
  assert.equal(found.value.name, 'classify');
  assert.equal(found.value.substitutedFor, undefined);
  assert.equal(found.value.entry.model, 'fast');
  const named = resolveModel(config(allowing('judgement')), 'judgement', ['home'], 'judgement');
  assert.ok(named.ok && named.value.substitutedFor === undefined, 'asking for the default by name is not a substitution');
});

test('a name that is not configured is answered by the role\'s default, marked as substituted', () => {
  const found = resolveModel(config(allowing('judgement')), 'judgement', ['home'], 'telepathy');
  assert.ok(found.ok);
  assert.equal(found.value.name, 'judgement');
  assert.equal(found.value.substitutedFor, 'telepathy');
});

test('a name configured with another role is refused, never answered by the default', () => {
  assert.deepEqual(resolveModel(config(allowing('judgement', 'quick')), 'judgement', ['home'], 'quick'),
    { ok: false, error: { reason: 'wrong-role', role: 'judgement', name: 'quick', actual: 'agent' } });
  assert.deepEqual(resolveModel(config(allowing('agent', 'classify')), 'agent', ['home'], 'classify'),
    { ok: false, error: { reason: 'wrong-role', role: 'agent', name: 'classify', actual: 'judgement' } });
  // The default of another role is not a default of this one.
  assert.equal(resolveModel(config(allowing('embed')), 'judgement', ['home'], 'embed').ok, false);
});

test('with no default for the role nothing answers: the feature is off, not an error elsewhere', () => {
  const without = { ...models };
  delete (without as Record<string, ModelEntry>)['agent'];
  assert.deepEqual(resolveModel(config(allowing('quick'), without), 'agent', ['home']), { ok: false, error: { reason: 'no-default', role: 'agent' } });
  assert.deepEqual(resolveModel(config(allowing('quick'), without), 'agent', ['home'], 'missing'), { ok: false, error: { reason: 'no-default', role: 'agent', requested: 'missing' } });
  assert.ok(resolveModel(config(allowing('quick'), without), 'agent', ['home'], 'quick').ok, 'a configured name still answers');
  assert.deepEqual(resolveModel(config([], {}), 'embed', ['home']), { ok: false, error: { reason: 'no-default', role: 'embed' } }, 'no models at all');
});

test('a configured model the policy does not allow is never replaced by the default', () => {
  // `classify` is configured but not allowed for the vault; `judgement` is allowed. The request fails.
  assert.deepEqual(resolveModel(config(allowing('judgement')), 'judgement', ['home'], 'classify'),
    { ok: false, error: { reason: 'not-allowed', role: 'judgement', name: 'classify', vault: 'home' } });
  assert.deepEqual(resolveModel(config(allowing('agent')), 'agent', ['home'], 'quick'),
    { ok: false, error: { reason: 'not-allowed', role: 'agent', name: 'quick', vault: 'home' } });
});

test('policy is checked on the model actually used: a substituted default must itself be allowed', () => {
  // `telepathy` is not configured, so the default answers; the policy allowing a name that was only requested helps nothing.
  assert.deepEqual(resolveModel(config(allowing('telepathy')), 'judgement', ['home'], 'telepathy'),
    { ok: false, error: { reason: 'not-allowed', role: 'judgement', name: 'judgement', vault: 'home' } });
  assert.deepEqual(resolveModel(config([]), 'agent', ['home']), { ok: false, error: { reason: 'not-allowed', role: 'agent', name: 'agent', vault: 'home' } }, 'no policy allows nothing');
});

test('every vault whose content is involved must allow the model, possibly by different entries', () => {
  const policy = [{ vaults: ['home'], allowModels: ['embed'] }, { vaults: ['home', 'work'], allowModels: ['judgement'] }];
  assert.ok(resolveModel(config(policy), 'judgement', ['home', 'work']).ok);
  assert.deepEqual(resolveModel(config(policy), 'embed', ['home', 'work']), { ok: false, error: { reason: 'not-allowed', role: 'embed', name: 'embed', vault: 'work' } });
  assert.ok(resolveModel(config([]), 'embed', []).ok, 'no vault content involved');
});
