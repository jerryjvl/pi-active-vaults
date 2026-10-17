// Documented behaviour: concepts.md "Actor", architecture.md "Review and
// accept" and security.md — a proposal is an actor's branch ahead of the
// accepted `main`; review shows its commits, changes, check results and
// control-change flags and records the SHA reviewed, per reviewer; accept, by
// an owner, takes the SHA from that owner's own latest review, gathers
// attestations for it, evaluates the merge policy, merges only that SHA, and
// records the result as the accepted `main`. It refuses if the owner has not
// reviewed, if the branch has moved, if `main` has an unaccepted change, or in
// forge mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accept, actorsSchema, readProposal, review, reviewRecord } from '../../../src/core/actors/index.ts';
import { readAttestations } from '../../../src/core/attestations/index.ts';
import { acceptedMain, integritySchema, integrityStatus } from '../../../src/core/integrity/index.ts';
import { STATE_FILE, openStore } from '../../../src/core/store/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';
import { scriptSource, withTestVault, type TestVault } from '../../support/vault.ts';

const ALICE = { name: 'Alice', email: 'alice@example.net' };

const context = (v: TestVault) => ({ git: v.git, store: v.store, clock: v.clock });
const OWNER_ONLY = 'merge:\n  - paths: ["**"]\n    require: [owner]';

test('a proposal is the actor\'s commits ahead of the accepted main, with its changes and taint', withTestVault(async (v) => {
  const accepted = v.accept();
  v.propose({ 'notes/a.md': 'a' });
  const clean = await readProposal(v.git, v.repo.path, accepted, 'gardener');
  assert.ok(clean.ok);
  assert.equal(clean.value.base, accepted.sha);
  assert.deepEqual(clean.value.changes, [{ path: 'notes/a.md', change: 'created' }]);
  assert.equal(clean.value.tainted, false);
  v.propose({ 'notes/b.md': 'b' }, 'made by hand, outside the package');
  const handMade = await readProposal(v.git, v.repo.path, accepted, 'gardener');
  assert.ok(handMade.ok && handMade.value.tainted);
  assert.equal(handMade.value.commits.length, 2);
  const none = await readProposal(v.git, v.repo.path, accepted, 'librarian');
  assert.equal(!none.ok && none.error.reason, 'no-proposal');
}));

test('review shows checks, control changes and the policy verdict, and records the SHA reviewed', withTestVault(async (v) => {
  v.repo.write('.vault/checks/links.sh', scriptSource('links'));
  v.repo.commit('check');
  v.accept();
  const head = v.propose({ 'notes/a.md': 'a', 'topics/_contract.md': '---\nindex: none\n---\n' });
  const reviewed = await review(context(v), v.vault, 'gardener', 'bob');
  assert.ok(reviewed.ok);
  assert.equal(reviewed.value.record.sha, head);
  assert.deepEqual(reviewed.value.evaluation.checks, [{ name: 'links', status: 'missing' }]);
  assert.deepEqual(reviewed.value.evaluation.control.map((c) => c.path), ['topics/_contract.md']);
  assert.deepEqual(reviewed.value.evaluation.verdict.requirements.map((r) => [r.requirement, r.met]), [['checks', false], ['owner', false]]);
  assert.deepEqual(reviewRecord(v.store, 'home', 'gardener', 'bob'), { vault: 'home', actor: 'gardener', sha: head, reviewer: 'bob', at: '2026-01-01T00:00:00.000Z' });
}, { extra: 'merge:\n  - paths: ["**"]\n    require: [checks]' }));

test('each reviewer has their own latest review record', withTestVault(async (v) => {
  v.accept();
  const first = v.propose({ 'a.md': 'a' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  const second = v.propose({ 'a.md': 'b' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'bob')).ok);
  assert.equal(reviewRecord(v.store, 'home', 'gardener', 'alice')?.sha, first);
  assert.equal(reviewRecord(v.store, 'home', 'gardener', 'bob')?.sha, second);
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  assert.equal(reviewRecord(v.store, 'home', 'gardener', 'alice')?.sha, second);
  assert.equal(reviewRecord(v.store, 'home', 'gardener', 'carol'), undefined);
}));

test('review continues while main has an unaccepted change; there must be something to review', withTestVault(async (v) => {
  v.accept();
  const nothing = await review(context(v), v.vault, 'gardener', 'bob');
  assert.equal(!nothing.ok && nothing.error.reason, 'no-proposal');
  v.propose({ 'a.md': 'a' });
  v.repo.write('stray.md', 'x');
  v.repo.commit('stray on main');
  assert.ok((await review(context(v), v.vault, 'gardener', 'bob')).ok);
}));

test('accept merges exactly the reviewed SHA as the owner, records the approval, and makes the merge the accepted main', withTestVault(async (v) => {
  const before = v.accept();
  const head = v.propose({ 'notes/a.md': 'a' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  v.clock.advance(1000);
  const accepted = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.ok(accepted.ok);
  const mainTip = v.repo.git('rev-parse', 'main');
  assert.equal(accepted.value.accepted.sha, mainTip);
  assert.equal(v.repo.git('rev-parse', `${mainTip}^1`), before.sha);
  assert.equal(v.repo.git('rev-parse', `${mainTip}^2`), head);
  assert.equal(v.repo.git('log', '-1', '--format=%an <%ae>', mainTip), 'Alice <alice@example.net>');
  assert.deepEqual({ ...acceptedMain(v.store, 'home') }, { vault: 'home', sha: mainTip, how: 'accept', by: 'alice', at: '2026-01-01T00:00:01.000Z' });
  const approvals = await readAttestations(v.git, v.repo.path, head);
  assert.ok(approvals.ok);
  assert.deepEqual(approvals.value.map((a) => [a.kind, a.name, a.result, a.by]), [['approval', 'alice', 'pass', 'alice']]);
  const status = await integrityStatus(v.git, v.store, v.vault);
  assert.equal(status.ok && status.value.state, 'accepted');
}, { extra: OWNER_ONLY }));

test('a branch that moved after review is refused, and main is left alone', withTestVault(async (v) => {
  const before = v.accept();
  v.propose({ 'a.md': 'reviewed' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  v.propose({ 'a.md': 'slipped in after review' });
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.equal(!refused.ok && refused.error.reason, 'branch-moved');
  assert.equal(v.repo.git('rev-parse', 'main'), before.sha);
}, { extra: OWNER_ONLY }));

test('a review by anyone else never satisfies an owner\'s accept, and main is left alone', withTestVault(async (v) => {
  const before = v.accept();
  const head = v.propose({ 'a.md': 'a' });
  // Another owner, and the actor itself, have reviewed the exact tip; alice has not.
  assert.ok((await review(context(v), v.vault, 'gardener', 'bob')).ok);
  assert.ok((await review(context(v), v.vault, 'gardener', 'gardener')).ok);
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.deepEqual(!refused.ok && refused.error, { reason: 'not-reviewed', actor: 'gardener', approver: 'alice' });
  assert.equal(v.repo.git('rev-parse', 'main'), before.sha);
  const notes = await readAttestations(v.git, v.repo.path, head);
  assert.deepEqual(notes.ok && notes.value, [], 'no approval is recorded');
}, { owners: ['alice', 'bob'], extra: OWNER_ONLY }));

test('accept uses the approver\'s own latest review, even when someone else reviewed the current tip', withTestVault(async (v) => {
  const before = v.accept();
  v.propose({ 'a.md': 'seen by alice' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  v.propose({ 'a.md': 'seen only by bob' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'bob')).ok);
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.equal(!refused.ok && refused.error.reason, 'branch-moved');
  assert.equal(v.repo.git('rev-parse', 'main'), before.sha);
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  assert.ok((await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE })).ok);
}, { owners: ['alice', 'bob'], extra: OWNER_ONLY }));

test('accept needs a review, an owner, and no unaccepted change on main', withTestVault(async (v) => {
  v.accept();
  v.propose({ 'a.md': 'a' });
  const unreviewed = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.equal(!unreviewed.ok && unreviewed.error.reason, 'not-reviewed');
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  const stranger = await accept(context(v), v.vault, 'gardener', { approver: 'gardener', identity: ALICE });
  assert.equal(!stranger.ok && stranger.error.reason, 'not-owner');
  v.repo.write('stray.md', 'x');
  v.repo.commit('stray on main');
  const paused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.equal(!paused.ok && paused.error.reason, 'unaccepted-change');
}, { extra: OWNER_ONLY }));

test('an unmet merge policy refuses the accept, says what is missing, and leaves main alone', withTestVault(async (v) => {
  v.repo.write('.vault/checks/links.sh', scriptSource('links'));
  v.repo.commit('check');
  const before = v.accept();
  v.propose({ 'a.md': 'a' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.ok(!refused.ok && refused.error.reason === 'policy-unmet');
  assert.deepEqual(refused.error.verdict.requirements.filter((r) => !r.met).map((r) => r.requirement), ['checks']);
  assert.equal(v.repo.git('rev-parse', 'main'), before.sha);
  assert.equal(acceptedMain(v.store, 'home')?.sha, before.sha);
}, { extra: 'merge:\n  - paths: ["**"]\n    require: [checks, owner]' }));

test('a tainted proposal meets the rules\' when-tainted requirements too', withTestVault(async (v) => {
  v.accept();
  v.propose({ 'a.md': 'a' }, 'made outside the package');
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.ok(!refused.ok && refused.error.reason === 'policy-unmet');
  assert.deepEqual(refused.error.verdict.requirements.filter((r) => !r.met).map((r) => r.requirement), ['judgement:quality']);
}, { extra: 'merge:\n  - paths: ["**"]\n    require: [owner]\n    when-tainted: [judgement:quality]\naxes:\n  quality: { type: bool, instructions: Right?, pass-when: "yes > 0.8" }' }));

test('forge-mode vaults are merged by the forge, never by a local accept', withTestVault(async (v) => {
  v.accept();
  v.propose({ 'a.md': 'a' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.equal(!refused.ok && refused.error.reason, 'forge-mode');
}, { review: 'forge', extra: OWNER_ONLY }));

test('main must be checked out in the vault to merge into it', withTestVault(async (v) => {
  v.accept();
  v.propose({ 'a.md': 'a' });
  assert.ok((await review(context(v), v.vault, 'gardener', 'alice')).ok);
  v.repo.git('checkout', '--quiet', '--detach');
  const refused = await accept(context(v), v.vault, 'gardener', { approver: 'alice', identity: ALICE });
  assert.equal(!refused.ok && refused.error.reason, 'main-not-checked-out');
}, { extra: OWNER_ONLY }));

test('reviews recorded before reviews were kept per reviewer survive the upgrade, under their reviewer', withTempDir(async (dir) => {
  const path = dir.file('state.sqlite');
  const v1 = openStore(path, STATE_FILE, [integritySchema, { ...actorsSchema, migrations: actorsSchema.migrations.slice(0, 1) }]);
  assert.ok(v1.ok);
  v1.value.run("INSERT INTO actors_reviews (vault, actor, sha, reviewer, at) VALUES ('home', 'gardener', 'abc', 'alice', 'then')");
  v1.value.close();
  const upgraded = openStore(path, STATE_FILE, [integritySchema, actorsSchema]);
  assert.ok(upgraded.ok);
  try {
    assert.deepEqual(reviewRecord(upgraded.value, 'home', 'gardener', 'alice'), { vault: 'home', actor: 'gardener', sha: 'abc', reviewer: 'alice', at: '2026-01-01T00:00:00.000Z' });
    assert.equal(reviewRecord(upgraded.value, 'home', 'gardener', 'bob'), undefined);
  } finally {
    upgraded.value.close();
  }
}));
