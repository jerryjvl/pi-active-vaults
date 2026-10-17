// Documented behaviour: principles 3 and 4, concepts.md "Merge policy" and
// security.md — policy is evaluated against the exact commit under review,
// with the rules, owners and checks of the accepted `main` (a proposal cannot
// loosen the rules it is judged by), and attestations for that exact commit or
// content. A policy that cannot be read blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAttestation, type Attestation } from '../../../src/core/attestations/index.ts';
import { axesVersion, evaluateMerge } from '../../../src/core/policy/index.ts';
import { TEST_ATTRIBUTION } from '../../support/git-repo.ts';
import { scriptSource, withTestVault, type TestVault } from '../../support/vault.ts';

async function attest(v: TestVault, attestation: Omit<Attestation, 'at' | 'by'> & { by?: string }): Promise<void> {
  const recorded = await recordAttestation(v.git, v.repo.path, { by: attestation.name, at: '2026-01-01T00:00:00.000Z', ...attestation }, TEST_ATTRIBUTION);
  if (!recorded.ok) assert.fail(JSON.stringify(recorded.error));
}

const RULES = 'merge:\n  - paths: ["**"]\n    require: [checks]\n  - paths: ["topics/**"]\n    require: [judgement:quality]\naxes:\n  quality: { type: bool, instructions: Is it right?, pass-when: "yes > 0.8" }';

test('a proposal is judged by the accepted main\'s rules, even when it rewrites them', withTestVault(async (v) => {
  v.repo.write('.vault/checks/links.sh', scriptSource('links', 'exit 0'));
  v.repo.commit('add a check');
  const accepted = v.accept();
  const head = v.propose({ '_contract.md': '---\nvault: { id: home }\n---\n', 'topics/a.md': 'claim' });
  const evaluated = await evaluateMerge(v.git, v.repo.path, { accepted, base: accepted.sha, head, tainted: false });
  assert.ok(evaluated.ok);
  assert.equal(evaluated.value.verdict.satisfied, false);
  assert.deepEqual(evaluated.value.verdict.requirements.map((r) => [r.requirement, r.met]), [['checks', false], ['owner', false], ['judgement:quality', false]]);
  assert.deepEqual(evaluated.value.control.map((c) => c.path), ['_contract.md']);
}, { extra: RULES }));

test('attestations count for the exact commit and content under review, at the accepted main\'s versions', withTestVault(async (v) => {
  v.repo.write('.vault/checks/links.sh', scriptSource('links', 'exit 0'));
  const sha = v.repo.commit('add a check');
  const accepted = v.accept();
  const linksVersion = v.repo.git('rev-parse', `${sha}:.vault/checks/links.sh`);
  const earlier = v.propose({ 'topics/a.md': 'first draft' });
  await attest(v, { kind: 'check', name: 'links', subject: earlier, result: 'pass', version: linksVersion });
  const head = v.propose({ 'topics/a.md': 'second draft' });
  const blob = v.repo.git('rev-parse', `${head}:topics/a.md`);
  const quality = { type: 'bool', instructions: 'Is it right?', 'pass-when': 'yes > 0.8' };

  const evaluate = () => evaluateMerge(v.git, v.repo.path, { accepted, base: accepted.sha, head, tainted: false });
  const before = await evaluate();
  assert.ok(before.ok);
  assert.equal(before.value.verdict.requirements.find((r) => r.requirement === 'checks')?.met, false, 'a pass for an earlier commit does not count');

  await attest(v, { kind: 'check', name: 'links', subject: head, result: 'pass', version: linksVersion });
  await attest(v, { kind: 'judgement', name: 'quality', subject: blob, result: 'pass', version: axesVersion(quality) });
  await attest(v, { kind: 'approval', name: 'alice', subject: head, result: 'pass' });
  const after = await evaluate();
  assert.ok(after.ok);
  assert.deepEqual(after.value.verdict.requirements.map((r) => [r.requirement, r.met]), [['checks', true], ['judgement:quality', true]]);
  assert.equal(after.value.verdict.satisfied, true);
}, { extra: RULES }));

test('a merge policy that cannot be read blocks, naming where it is wrong', withTestVault(async (v) => {
  const accepted = v.accept();
  const head = v.propose({ 'a.md': 'x' });
  const evaluated = await evaluateMerge(v.git, v.repo.path, { accepted, base: accepted.sha, head, tainted: false });
  assert.equal(!evaluated.ok && evaluated.error.reason, 'invalid-policy');
}, { extra: 'merge:\n  - paths: ["**"]\n    require: [ownr]' }));

test('the axes version names the definition, independent of key order', () => {
  assert.equal(axesVersion({ type: 'bool', instructions: 'x' }), axesVersion({ instructions: 'x', type: 'bool' }));
  assert.notEqual(axesVersion({ type: 'bool', instructions: 'x' }), axesVersion({ type: 'bool', instructions: 'y' }));
});

test('approvals given elsewhere (a forge\'s reviews) count only as approvals of the exact commit under review', withTestVault(async (v) => {
  const accepted = v.accept();
  const head = v.propose({ 'notes/a.md': 'x' });
  const approval = (subject: string, kind: Attestation['kind'] = 'approval'): Attestation =>
    ({ kind, name: 'alice', subject, result: 'pass', by: 'alice via forge', at: '2026-01-01T00:00:00.000Z' });
  const owner = async (approvals: Attestation[]) => {
    const evaluated = await evaluateMerge(v.git, v.repo.path, { accepted, base: accepted.sha, head, tainted: false, approvals });
    assert.ok(evaluated.ok);
    return evaluated.value.verdict.requirements.find((r) => r.requirement === 'owner')?.met;
  };
  assert.equal(await owner([approval(head)]), true);
  assert.equal(await owner([approval(accepted.sha)]), false, 'another commit');
  assert.equal(await owner([approval(head, 'check')]), false, 'not an approval');
}, { extra: 'merge:\n  - { paths: ["**"], require: [owner] }' }));
