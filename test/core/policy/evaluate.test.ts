// Documented behaviour: concepts.md "Merge policy" and "Attestation" — every
// changed path must satisfy every rule whose globs match it; `checks` needs
// every check passed for the exact commit at its accepted-main version;
// `owner` an owner's approval of the exact commit; `judgement:<name>` a passing
// judgement of the path's current content and axes (a deleted path needs
// `owner` instead); `when-tainted` adds requirements for tainted proposals; a
// control change always needs `owner`. Anything missing, stale or failed is
// unmet — gates fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Attestation } from '../../../src/core/attestations/index.ts';
import { evaluatePolicy, type MergeRule, type PolicyChange, type PolicyInput } from '../../../src/core/policy/index.ts';

const HEAD = 'c'.repeat(40);
const BLOB = 'b'.repeat(40);
const OLD_BLOB = 'd'.repeat(40);
const LINKS_V2 = '2'.repeat(40);

const rule = (paths: string[], require: string[], whenTainted: string[] = []): MergeRule =>
  ({ paths, require, whenTainted }) as MergeRule;

const change = (path: string, rules: MergeRule[], overrides: Partial<PolicyChange> = {}): PolicyChange =>
  ({ path, deleted: false, content: BLOB, control: false, rules, judgementVersions: { quality: 'axes-1' }, ...overrides });

const verdict = (kind: Attestation['kind'], name: string, result: string, overrides: Partial<Attestation> = {}): Attestation =>
  ({ kind, name, subject: HEAD, result, by: name, at: 't', ...overrides });

function input(changes: PolicyChange[], overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    subject: HEAD,
    changes,
    tainted: false,
    owners: ['alice', 'bob'],
    checks: [{ name: 'links', version: LINKS_V2 }],
    invalidChecks: [],
    attestations: { commit: [], content: new Map() },
    ...overrides,
  };
}

const summary = (i: PolicyInput) => {
  const v = evaluatePolicy(i);
  return { satisfied: v.satisfied, requirements: v.requirements.map((r) => `${r.requirement} ${r.met ? 'met' : 'unmet'} [${r.paths.join(',')}]`) };
};

test('a path needs the requirements of every rule whose globs match it, and no others', () => {
  const rules = [rule(['**'], ['owner']), rule(['topics/**'], ['checks']), rule(['notes/**'], ['judgement:quality'])];
  assert.deepEqual(summary(input([change('topics/a.md', rules)])), {
    satisfied: false,
    requirements: ['checks unmet [topics/a.md]', 'owner unmet [topics/a.md]'],
  });
  assert.deepEqual(summary(input([change('elsewhere.md', [rule(['topics/**'], ['owner'])])])), { satisfied: true, requirements: [] });
});

test('checks are met only when every check passed for the exact commit at its accepted-main version', () => {
  const rules = [rule(['**'], ['checks'])];
  const pass = verdict('check', 'links', 'pass', { version: LINKS_V2 });
  assert.equal(evaluatePolicy(input([change('a.md', rules)], { attestations: { commit: [pass], content: new Map() } })).satisfied, true);
  const cases: [string, Partial<PolicyInput>][] = [
    ['missing', { attestations: { commit: [], content: new Map() } }],
    ['failed', { attestations: { commit: [pass, verdict('check', 'links', 'fail', { version: LINKS_V2 })], content: new Map() } }],
    ['older version', { attestations: { commit: [verdict('check', 'links', 'pass', { version: '1'.repeat(40) })], content: new Map() } }],
    ['unusable check', { attestations: { commit: [pass], content: new Map() }, invalidChecks: ['spelling'] }],
  ];
  for (const [what, overrides] of cases) {
    const v = evaluatePolicy(input([change('a.md', rules)], overrides));
    assert.equal(v.satisfied, false, what);
    assert.ok((v.requirements[0]?.reasons.length ?? 0) > 0, `${what} says why`);
  }
});

test('owner is met by an owner\'s latest approval of the exact commit, never by anyone else\'s', () => {
  const rules = [rule(['**'], ['owner'])];
  const approved = (commit: Attestation[]) => evaluatePolicy(input([change('a.md', rules)], { attestations: { commit, content: new Map() } })).satisfied;
  assert.equal(approved([verdict('approval', 'bob', 'pass')]), true);
  assert.equal(approved([verdict('approval', 'mallory', 'pass')]), false);
  assert.equal(approved([verdict('approval', 'bob', 'pass'), verdict('approval', 'bob', 'fail')]), false, 'withdrawn');
  assert.equal(approved([]), false);
});

test('a judgement counts only for the path\'s current content and the axes now in effect', () => {
  const rules = [rule(['**'], ['judgement:quality'])];
  const judged = (content: Attestation[], overrides: Partial<PolicyChange> = {}) =>
    evaluatePolicy(input([change('a.md', rules, overrides)], { attestations: { commit: [], content: new Map([[BLOB, content]]) } })).satisfied;
  const pass = verdict('judgement', 'quality', 'pass', { subject: BLOB, version: 'axes-1' });
  assert.equal(judged([pass]), true);
  assert.equal(judged([pass], { content: OLD_BLOB }), false, 'content changed since it was judged');
  assert.equal(judged([{ ...pass, version: 'axes-0' }]), false, 'axes changed since it was judged');
  assert.equal(judged([{ ...pass, result: 'fail' }]), false);
  assert.equal(judged([pass], { judgementVersions: {} }), false, 'no such judgement in effect');
});

test('a deleted path cannot be judged, so it needs an owner instead', () => {
  const rules = [rule(['**'], ['judgement:quality'])];
  assert.deepEqual(summary(input([change('gone.md', rules, { deleted: true })])), {
    satisfied: false,
    requirements: ['owner unmet [gone.md]'],
  });
});

test('a control change needs an owner whatever the rules say', () => {
  assert.deepEqual(summary(input([change('_contract.md', [], { control: true })])), {
    satisfied: false,
    requirements: ['owner unmet [_contract.md]'],
  });
  const approved = input([change('_contract.md', [], { control: true })], { attestations: { commit: [verdict('approval', 'alice', 'pass')], content: new Map() } });
  assert.equal(evaluatePolicy(approved).satisfied, true);
});

test('when-tainted requirements apply only to tainted proposals', () => {
  const rules = [rule(['**'], ['checks'], ['owner'])];
  const pass = verdict('check', 'links', 'pass', { version: LINKS_V2 });
  const evaluated = (tainted: boolean) => summary(input([change('a.md', rules)], { tainted, attestations: { commit: [pass], content: new Map() } }));
  assert.deepEqual(evaluated(false), { satisfied: true, requirements: ['checks met [a.md]'] });
  assert.deepEqual(evaluated(true), { satisfied: false, requirements: ['checks met [a.md]', 'owner unmet [a.md]'] });
});

test('requirements are listed once each, with every path needing them, in a stable order', () => {
  const rules = [rule(['**'], ['judgement:quality', 'owner', 'checks'])];
  const v = evaluatePolicy(input([change('b.md', rules), change('a.md', rules)]));
  assert.deepEqual(v.requirements.map((r) => [r.requirement, r.paths]), [
    ['checks', ['a.md', 'b.md']],
    ['owner', ['a.md', 'b.md']],
    ['judgement:quality', ['a.md', 'b.md']],
  ]);
});
