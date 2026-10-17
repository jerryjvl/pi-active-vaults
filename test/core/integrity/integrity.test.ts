// Documented behaviour: security.md — each vault has an accepted `main`; when
// the tip of `main` differs from it (new commits, a reset, a rewrite) the vault
// has an unaccepted change, reported by a notice naming the vault and the
// commit, and every propagating action refuses until an owner adopts it (see
// actors/adopt.test.ts) or main is reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedMain,
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

