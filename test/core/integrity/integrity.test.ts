// Documented behaviour: security.md — each vault has an accepted `main`; when
// the tip of `main` differs from it (new commits, a reset, a rewrite) the vault
// has an unaccepted change, reported by a notice naming the vault and the
// commit, and every propagating action refuses until an owner adopts it or
// main is reset. Adopting shows the delta, flags rewritten history, and in
// forge mode is refused (resolved by syncing instead).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedMain,
  adopt,
  adoptionDelta,
  integrityStatus,
  recordAccepted,
  requireNoUnacceptedChange,
  unacceptedNotice,
} from '../../../src/core/integrity/index.ts';
import { openStateStore } from '../../../src/core/operations/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';
import { withTestVault } from '../../support/vault.ts';

test('a vault with no accepted main yet has an unaccepted change', withTestVault(async ({ git, store, vault, initial }) => {
  const status = await integrityStatus(git, store, vault);
  assert.ok(status.ok);
  assert.equal(status.value.state, 'unaccepted');
  if (status.value.state === 'unaccepted') {
    assert.equal(status.value.change, 'none-accepted');
    assert.equal(status.value.tip, initial);
  }
}));

test('main at the accepted main is accepted', withTestVault(async ({ git, store, vault, accept }) => {
  const accepted = accept();
  assert.deepEqual(await integrityStatus(git, store, vault), { ok: true, value: { state: 'accepted', accepted } });
}));

test('a new commit on main is an unaccepted change listing its commits, and the notice names the vault and commit', withTestVault(async ({ repo, git, store, vault, accept }) => {
  accept();
  repo.write('stray.md', 'x');
  const stray = repo.commit('stray commit');
  const status = await integrityStatus(git, store, vault);
  assert.ok(status.ok && status.value.state === 'unaccepted');
  assert.equal(status.value.change, 'ahead');
  assert.deepEqual(status.value.commits.map((c) => c.sha), [stray]);
  const notice = unacceptedNotice(status.value, 'local');
  assert.match(notice, /home/);
  assert.match(notice, new RegExp(stray));
  assert.match(notice, /vault accept --adopt/);
}));

test('a reset and a rewrite are unaccepted changes too; a rewrite is flagged', withTestVault(async ({ repo, git, store, vault, accept }) => {
  repo.write('a.md', 'a');
  repo.commit('a');
  accept();
  repo.git('reset', '--quiet', '--hard', 'HEAD~1');
  const behind = await integrityStatus(git, store, vault);
  assert.ok(behind.ok && behind.value.state === 'unaccepted' && behind.value.change === 'behind');
  repo.write('b.md', 'b');
  const rewritten = repo.commit('rewritten history');
  const diverged = await integrityStatus(git, store, vault);
  assert.ok(diverged.ok && diverged.value.state === 'unaccepted' && diverged.value.change === 'diverged');
  assert.deepEqual(diverged.value.commits.map((c) => c.sha), [rewritten]);
}));

test('a missing main is an unaccepted change', withTestVault(async ({ repo, git, store, vault, accept }) => {
  accept();
  repo.git('checkout', '--quiet', '-b', 'elsewhere');
  repo.git('branch', '--quiet', '-D', 'main');
  const status = await integrityStatus(git, store, vault);
  assert.ok(status.ok && status.value.state === 'unaccepted');
  assert.equal(status.value.change, 'main-missing');
  assert.equal(status.value.tip, null);
  assert.match(unacceptedNotice(status.value, 'local'), /main is missing/);
}));

test('propagating actions are refused while there is an unaccepted change, and allowed once resolved by resetting main', withTestVault(async ({ repo, git, store, vault, accept }) => {
  const accepted = accept();
  assert.deepEqual(await requireNoUnacceptedChange(git, store, vault), { ok: true, value: accepted });
  repo.write('stray.md', 'x');
  repo.commit('stray');
  const refused = await requireNoUnacceptedChange(git, store, vault);
  assert.equal(!refused.ok && refused.error.reason, 'unaccepted-change');
  repo.git('reset', '--quiet', '--hard', accepted.sha); // discard the change
  assert.deepEqual(await requireNoUnacceptedChange(git, store, vault), { ok: true, value: accepted });
}));

test('recording the accepted main is compare-and-swap, per vault', withTestVault(async ({ repo, store, clock, initial }) => {
  const next = repo.commit('next');
  const at = clock.now();
  assert.ok(recordAccepted(store, 'home', { sha: initial, how: 'init', by: 'alice', at }, null).ok);
  assert.deepEqual(recordAccepted(store, 'home', { sha: next, how: 'accept', by: 'alice', at }, null), {
    ok: false,
    error: { reason: 'accepted-moved', current: initial },
  });
  assert.ok(recordAccepted(store, 'other', { sha: next, how: 'init', by: 'bob', at }, null).ok);
  const recorded = recordAccepted(store, 'home', { sha: next, how: 'accept', by: 'alice', at }, initial);
  assert.ok(recorded.ok);
  assert.deepEqual(
    { ...acceptedMain(store, 'home') },
    { vault: 'home', sha: next, how: 'accept', by: 'alice', at: '2026-01-01T00:00:00.000Z' },
  );
}));

test('the accepted main is durable state: it survives reopening the store', withTempDir(async (dir) => {
  const path = dir.file('state.sqlite');
  const sha = 'a'.repeat(40);
  const first = openStateStore({ stateDb: path });
  assert.ok(first.ok);
  recordAccepted(first.value, 'home', { sha, how: 'init', by: 'alice', at: new Date(0) }, null);
  first.value.close();
  const second = openStateStore({ stateDb: path });
  assert.ok(second.ok);
  assert.equal(acceptedMain(second.value, 'home')?.sha, sha);
  second.value.close();
}));

test('adopting shows the commits and diff from the accepted main, then records the tip once an owner confirms', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  const before = accept();
  repo.write('stray.md', 'stray content\n');
  const stray = repo.commit('stray commit');
  const delta = await adoptionDelta(git, store, vault, stray);
  assert.ok(delta.ok);
  assert.equal(delta.value.from?.sha, before.sha);
  assert.deepEqual(delta.value.commits.map((c) => c.sha), [stray]);
  assert.equal(delta.value.rewritten, false);
  assert.match(delta.value.diff, /\+stray content/);

  clock.advance(60_000);
  const adopted = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.ok(adopted.ok);
  assert.deepEqual({ ...adopted.value }, { vault: 'home', sha: stray, how: 'adopt', by: 'alice', at: '2026-01-01T00:01:00.000Z' });
  const status = await integrityStatus(git, store, vault);
  assert.equal(status.ok && status.value.state, 'accepted');
}));

test('adopting flags rewritten history', withTestVault(async ({ repo, git, store, vault, accept }) => {
  repo.write('a.md', 'a');
  repo.commit('a');
  accept();
  repo.git('reset', '--quiet', '--hard', 'HEAD~1');
  repo.write('b.md', 'b');
  const rewritten = repo.commit('rewrite');
  const delta = await adoptionDelta(git, store, vault, rewritten);
  assert.ok(delta.ok && delta.value.rewritten);
}));

test('only an owner can adopt, only main\'s current tip, and never in forge mode', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  const before = accept();
  repo.write('stray.md', 'x');
  const stray = repo.commit('stray');
  const notOwner = await adopt(git, store, vault, { sha: stray, approver: 'gardener', clock });
  assert.equal(!notOwner.ok && notOwner.error.reason, 'not-owner');
  repo.write('more.md', 'y');
  repo.commit('main moved since');
  const moved = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.equal(!moved.ok && moved.error.reason, 'not-main-tip');
  assert.equal(acceptedMain(store, 'home')?.sha, before.sha);
}));

test('a forge-mode vault is never adopted locally', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  accept();
  repo.write('stray.md', 'x');
  const stray = repo.commit('stray');
  const refused = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.equal(!refused.ok && refused.error.reason, 'forge-mode');
}, { review: 'forge' }));

test('the first adoption of a newly registered vault takes its owners from the commit adopted', withTestVault(async ({ git, store, vault, clock, initial }) => {
  const refused = await adopt(git, store, vault, { sha: initial, approver: 'mallory', clock });
  assert.equal(!refused.ok && refused.error.reason, 'not-owner');
  const adopted = await adopt(git, store, vault, { sha: initial, approver: 'alice', clock });
  assert.ok(adopted.ok);
}));
