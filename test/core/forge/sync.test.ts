// Documented behaviour: concepts.md "Actor" (forge mode), architecture.md
// "Review and accept", daemon.md "Forge sync", security.md — in forge mode
// the package pushes actor branches and its notes (attestations and traces), opens or updates a
// pull request, and publishes each check's result and one `vault/policy`
// status saying whether the proposal satisfies the vault's merge policy, with
// owners' forge approvals of the exact commit. It never pushes `main`, and
// pushes an actor branch forced only to replace the forge's copy when that is
// exactly the head the forge reported merged (a lease on that commit). It
// learns about merges by fetching: the forge's `main` becomes the accepted
// `main`, and notes from the forge merge line by line. Pushing is a
// propagating action, refused during an unaccepted change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttestations, recordAttestation } from '../../../src/core/attestations/index.ts';
import { acceptedMain, integrityStatus } from '../../../src/core/integrity/index.ts';
import { checkMerges, proposeToForge, publishStatuses, pushToForge, syncWithForge, uncheckedMerges, type ForgeDeps } from '../../../src/core/forge/index.ts';
import { TEST_ATTRIBUTION, createTempRepo } from '../../support/git-repo.ts';
import { FORGE_TOKEN } from '../../support/forge-stub.ts';
import { connectToForge, mergeInForge, mergePullInForge, withForge, type Forge } from '../../support/forge-vault.ts';
import { scriptSource, withTestVault, type TestVault } from '../../support/vault.ts';

interface ForgeWithDeps extends Forge {
  readonly deps: ForgeDeps;
}

/** A forge-mode vault whose origin is a local bare repository behind the forge's URL, and a stub forge API. */
function withForgeFor(v: TestVault, run: (forge: ForgeWithDeps) => Promise<void>): Promise<void> {
  return withForge(async (forge) => {
    connectToForge(v.repo, forge);
    const deps: ForgeDeps = {
      git: v.git, store: v.store, clock: v.clock, attribution: TEST_ATTRIBUTION,
      forges: [{ host: 'git.example.net', type: 'gitea', token: { kind: 'env', name: 'T', where: 'forges[0].token' }, api: forge.stub.api, autoMerge: true }],
      client: { fetch, timeoutMs: 5000 },
      secrets: { env: { T: FORGE_TOKEN }, runCommand: async () => assert.fail('no command') },
    };
    await run({ ...forge, deps });
  });
}

const forgeVault = { review: 'forge' as const, extra: 'merge:\n  - { paths: ["**"], require: [checks, owner] }' };

test('syncing makes the forge\'s main the accepted main, fast-forwarding the local main', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    const first = await syncWithForge(forge.deps, v.vault);
    assert.ok(first.ok, JSON.stringify(first));
    assert.deepEqual([first.value.accepted.sha, first.value.accepted.how, first.value.accepted.by], [v.initial, 'sync', 'vault-bot']);

    const merged = mergeInForge(forge, { 'topics/a.md': 'merged in the forge\n' });
    const second = await syncWithForge(forge.deps, v.vault);
    assert.ok(second.ok);
    assert.deepEqual([second.value.accepted.sha, second.value.mainUpdated], [merged, true]);
    assert.equal(v.repo.git('rev-parse', 'main'), merged);
    const status = await integrityStatus(v.git, v.store, v.vault);
    assert.equal(status.ok && status.value.state, 'accepted');
  });
}, forgeVault));

test('a local main with commits the forge does not have stays an unaccepted change after syncing', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    v.repo.write('stray.md', 'local only\n');
    const stray = v.repo.commit('stray');
    const synced = await syncWithForge(forge.deps, v.vault);
    assert.ok(synced.ok);
    assert.deepEqual([synced.value.accepted.sha, synced.value.mainUpdated], [v.initial, false]);
    assert.equal(v.repo.git('rev-parse', 'main'), stray, 'local work is never thrown away');
    const status = await integrityStatus(v.git, v.store, v.vault);
    assert.equal(status.ok && status.value.state === 'unaccepted' && status.value.change, 'ahead');
  });
}, forgeVault));

test('attestation notes from the forge merge line by line with the local ones', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    const at = '2026-01-01T00:00:00.000Z';
    const record = (name: string) => ({ kind: 'check' as const, name, subject: v.initial, result: 'pass', by: name, version: 'v', at });
    assert.ok((await recordAttestation(v.git, v.repo.path, record('local'), TEST_ATTRIBUTION)).ok);
    const other = createTempRepo();
    try {
      other.git('fetch', '--quiet', forge.bare, 'main:refs/remotes/origin/main');
      other.git('notes', '--ref=refs/notes/vault/attestations', 'add', '-m', JSON.stringify(record('remote')), v.initial);
      other.git('push', '--quiet', forge.bare, 'refs/notes/vault/attestations:refs/notes/vault/attestations');
    } finally {
      other.cleanup();
    }
    assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
    const read = await readAttestations(v.git, v.repo.path, v.initial);
    assert.deepEqual(read.ok && read.value.map((a) => a.name).sort(), ['local', 'remote']);
  });
}, forgeVault));

test('trace notes travel like attestations: merged from the forge line by line, and pushed with a proposal', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
    const head = v.propose({ 'topics/a.md': 'x\n' });
    v.repo.git('notes', '--ref=refs/notes/vault/traces', 'add', '-m', '{"local":1}', head);
    v.repo.git('notes', '--ref=refs/notes/vault/traces', 'add', '-m', '{"here":1}', v.initial);
    const other = createTempRepo();
    try {
      other.git('fetch', '--quiet', forge.bare, 'main:refs/remotes/origin/main');
      other.git('notes', '--ref=refs/notes/vault/traces', 'add', '-m', '{"there":1}', v.initial);
      other.git('push', '--quiet', forge.bare, 'refs/notes/vault/traces:refs/notes/vault/traces');
    } finally {
      other.cleanup();
    }
    const proposed = await proposeToForge(forge.deps, v.vault, 'gardener');
    assert.ok(proposed.ok, JSON.stringify(proposed));
    assert.equal(forge.remote('notes', '--ref=refs/notes/vault/traces', 'show', head), '{"local":1}');
    assert.deepEqual(v.repo.git('notes', '--ref=refs/notes/vault/traces', 'show', v.initial).split('\n').filter((l) => l !== '').sort(), ['{"here":1}', '{"there":1}']);
    assert.equal(forge.remote('notes', '--ref=refs/notes/vault/traces', 'show', v.initial).includes('{"here":1}'), true, 'merged before pushing, so the push is a fast-forward');
  });
}, forgeVault));

test('proposing pushes the actor branch and notes, opens a pull request, then updates it; main is never pushed', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
    const head = v.propose({ 'topics/a.md': 'first\n' });
    v.repo.write('local.md', 'not pushed\n');
    const proposed = await proposeToForge(forge.deps, v.vault, 'gardener');
    assert.ok(proposed.ok, JSON.stringify(proposed));
    assert.equal(proposed.value.opened, true);
    assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), head);
    assert.equal(forge.remote('rev-parse', 'refs/heads/main'), v.initial);
    assert.deepEqual(forge.stub.model.pulls.map((p) => [p.head, p.base, p.title]), [['actor/gardener', 'main', 'Proposal from gardener']]);

    const next = v.propose({ 'topics/b.md': 'second\n' });
    const again = await proposeToForge(forge.deps, v.vault, 'gardener');
    assert.ok(again.ok);
    assert.equal(again.value.opened, false);
    assert.equal(forge.stub.model.pulls.length, 1, 'updated, not opened twice');
    assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), next);
  });
}, forgeVault));

test('nothing but actor branches and the package\'s notes is ever pushed', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    for (const refspec of ['refs/heads/main:refs/heads/main', 'refs/notes/vault/other:refs/notes/vault/other', 'refs/notes/vault/traces:refs/notes/vault/attestations', 'refs/heads/actor/gardener:refs/heads/main', '+refs/heads/main:refs/heads/actor/x', 'refs/heads/actor/a:refs/tags/v1']) {
      const pushed = await pushToForge(v.git, v.repo.path, [refspec]);
      assert.deepEqual(!pushed.ok && pushed.error, { reason: 'not-pushable', refspec }, refspec);
    }
    // The one forced push is a lease on an actor branch's own ref, nothing else's.
    for (const lease of [{ ref: 'refs/heads/main', sha: v.initial }, { ref: 'refs/notes/vault/traces', sha: v.initial }]) {
      const forced = await pushToForge(v.git, v.repo.path, ['refs/heads/actor/gardener:refs/heads/actor/gardener'], { lease });
      assert.deepEqual(!forced.ok && forced.error.reason, 'not-pushable', lease.ref);
    }
    assert.equal(forge.remote('rev-parse', 'refs/heads/main'), v.initial);
  });
}, forgeVault));

/** A proposal squash-merged in the forge and judged, with its branch then reset to main: the state in which the next proposal's push is not a fast-forward. Returns the head the forge reported merged. */
async function mergedAndReset(v: TestVault, forge: ForgeWithDeps): Promise<string> {
  assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
  const merged = v.propose({ 'topics/a.md': 'first\n' });
  assert.ok((await proposeToForge(forge.deps, v.vault, 'gardener')).ok);
  const asked = await uncheckedMerges(forge.deps, v.vault, ['gardener']);
  assert.ok(asked.ok && asked.value.length === 0, 'nothing merged yet');
  mergePullInForge(forge, 1, 'squash');
  const next = await uncheckedMerges(forge.deps, v.vault, ['gardener']);
  const synced = await syncWithForge(forge.deps, v.vault);
  assert.ok(next.ok && synced.ok);
  const judged = await checkMerges(forge.deps, v.vault, synced.value.accepted, next.value);
  assert.ok(judged.ok && judged.value.length === 1 && !judged.value[0]?.kept);
  v.repo.git('branch', '--force', 'actor/gardener', 'main');
  return merged;
}

test('after a merge that replaced a proposal\'s commits, the next proposal replaces the forge\'s copy of the branch — it is the head the forge reported merged — and main is untouched', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    const merged = await mergedAndReset(v, forge);
    assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), merged);
    const main = forge.remote('rev-parse', 'refs/heads/main');
    const next = v.propose({ 'topics/b.md': 'second\n' });
    const proposed = await proposeToForge(forge.deps, v.vault, 'gardener');
    assert.ok(proposed.ok, JSON.stringify(proposed));
    assert.equal(proposed.value.opened, true, 'the first pull request is merged: a new one');
    assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), next);
    assert.equal(forge.remote('rev-parse', 'refs/heads/main'), main);
  });
}, forgeVault));

test('a branch the forge holds at anything but the head it reported merged is never overwritten', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    await mergedAndReset(v, forge);
    // Someone pushed to the forge's copy since: the lease on the merged head no longer holds.
    const other = createTempRepo();
    try {
      other.git('fetch', '--quiet', forge.bare, 'refs/heads/actor/gardener:refs/heads/other');
      other.git('checkout', '--quiet', 'other');
      other.write('theirs.md', 'someone else\n');
      other.commit('Their work');
      other.git('push', '--quiet', forge.bare, 'HEAD:refs/heads/actor/gardener');
      const theirs = forge.remote('rev-parse', 'refs/heads/actor/gardener');
      v.propose({ 'topics/b.md': 'second\n' });
      const refused = await proposeToForge(forge.deps, v.vault, 'gardener');
      assert.equal(!refused.ok && refused.error.reason, 'git-failed');
      assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), theirs);
    } finally {
      other.cleanup();
    }
  });
}, forgeVault));

test('a branch that is not a fast-forward of the forge\'s copy is pushed unforced when the forge reported nothing merged from it', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
    const first = v.propose({ 'topics/a.md': 'first\n' });
    assert.ok((await proposeToForge(forge.deps, v.vault, 'gardener')).ok);
    v.repo.git('branch', '--force', 'actor/gardener', 'main');
    v.propose({ 'topics/b.md': 'second\n' });
    const refused = await proposeToForge(forge.deps, v.vault, 'gardener');
    assert.equal(!refused.ok && refused.error.reason, 'git-failed');
    assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), first);
  });
}, forgeVault));

test('proposing is refused while main has an unaccepted change, and nothing is pushed', withTestVault(async (v) => {
  await withForgeFor(v, async (forge) => {
    assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
    v.propose({ 'topics/a.md': 'x\n' });
    v.repo.write('stray.md', 'x');
    v.repo.commit('stray on main');
    const refused = await proposeToForge(forge.deps, v.vault, 'gardener');
    assert.equal(!refused.ok && refused.error.reason, 'unaccepted-change');
    assert.equal(forge.remote('branch', '--list', 'actor/gardener'), '');
    assert.deepEqual(forge.stub.model.pulls, []);
  });
}, forgeVault));

test('vault/policy carries the merge policy, counting only owners\' approvals of the exact commit; checks are published too', withTestVault(async (v) => {
  v.repo.write('.vault/checks/links.sh', scriptSource('links'));
  v.repo.commit('a check');
  await withForgeFor(v, async (forge) => {
    v.repo.git('push', '--quiet', 'origin', 'main');
    assert.ok((await syncWithForge(forge.deps, v.vault)).ok);
    const accepted = acceptedMain(v.store, 'home');
    assert.ok(accepted !== undefined);
    const older = v.propose({ 'topics/a.md': 'one\n' });
    const head = v.propose({ 'topics/a.md': 'two\n' });
    const version = v.repo.git('rev-parse', `${accepted.sha}:.vault/checks/links.sh`);
    const check = (result: string, at: string) =>
      recordAttestation(v.git, v.repo.path, { kind: 'check', name: 'links', subject: head, result, by: 'links', version, at }, TEST_ATTRIBUTION);
    const latest = () => Object.fromEntries(forge.stub.model.statuses.filter((s) => s.sha === head).map((s) => [s.context, s.state]));

    assert.ok((await check('fail', '2026-01-01T00:00:00.000Z')).ok);
    assert.ok((await proposeToForge(forge.deps, v.vault, 'gardener')).ok);
    assert.deepEqual(latest(), { 'vault/check/links': 'failure', 'vault/policy': 'failure' });

    assert.ok((await check('pass', '2026-01-01T00:01:00.000Z')).ok);
    forge.stub.model.reviews.push({ pull: 1, user: 'alice', state: 'APPROVED', commit: older }, { pull: 1, user: 'bob', state: 'APPROVED', commit: head });
    assert.ok((await publishStatuses(forge.deps, v.vault, 'gardener')).ok);
    assert.deepEqual(latest(), { 'vault/check/links': 'success', 'vault/policy': 'pending' }, 'an older commit\'s approval, or a non-owner\'s, does not count');

    forge.stub.model.reviews.push({ pull: 1, user: 'alice', state: 'APPROVED', commit: head });
    const published = await publishStatuses(forge.deps, v.vault, 'gardener');
    assert.ok(published.ok);
    assert.deepEqual(latest(), { 'vault/check/links': 'success', 'vault/policy': 'success' });
    assert.equal(published.value.policy.state, 'success');
  });
}, forgeVault));
