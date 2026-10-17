// Documented behaviour: concepts.md "Actor" — each actor (one of the root
// contract's actors or owners) writes on its own branch, `actor/<name>`, in its
// own worktree, `<worktrees>/<name>`. New work starts from the accepted
// `main`. Package commits carry the actor's trailers and never land anywhere
// but the actor's branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { actorBranch, commitAsActor, ensureActorWorktree } from '../../../src/core/actors/index.ts';
import { withTestVault } from '../../support/vault.ts';

test('an actor\'s worktree is made on its own branch, starting from the accepted main rather than main\'s tip', withTestVault(async (v) => {
  const accepted = v.accept();
  v.repo.write('stray.md', 'unaccepted');
  v.repo.commit('stray commit on main');
  const made = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
  assert.ok(made.ok);
  assert.deepEqual(made.value, { path: join(v.vault.worktrees, 'gardener'), branch: 'actor/gardener', created: true });
  assert.equal(v.repo.git('rev-parse', 'refs/heads/actor/gardener'), accepted.sha);
  assert.equal(existsSync(join(made.value.path, 'stray.md')), false);
  const again = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
  assert.deepEqual(again.ok && again.value, { ...made.value, created: false });
}));

test('an existing actor branch is checked out as it is, not reset', withTestVault(async (v) => {
  const accepted = v.accept();
  v.repo.git('branch', 'actor/gardener', accepted.sha);
  v.repo.git('checkout', '--quiet', 'actor/gardener');
  v.repo.write('work.md', 'earlier work');
  const earlier = v.repo.commit('earlier work');
  v.repo.git('checkout', '--quiet', 'main');
  const made = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
  assert.ok(made.ok);
  assert.equal(v.repo.git('rev-parse', 'refs/heads/actor/gardener'), earlier);
  assert.equal(existsSync(join(made.value.path, 'work.md')), true);
}));

test('only the vault\'s actors and owners get a worktree', withTestVault(async (v) => {
  const accepted = v.accept();
  const owner = await ensureActorWorktree(v.git, v.vault, accepted, 'alice');
  assert.ok(owner.ok);
  const stranger = await ensureActorWorktree(v.git, v.vault, accepted, 'mallory');
  assert.equal(!stranger.ok && stranger.error.reason, 'unknown-actor');
  assert.equal(actorBranch('gardener'), 'actor/gardener');
}));

test('a directory already holding another branch\'s worktree is not taken over', withTestVault(async (v) => {
  const accepted = v.accept();
  v.repo.git('worktree', 'add', '--quiet', '-b', 'elsewhere', join(v.vault.worktrees, 'gardener'), accepted.sha);
  const made = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
  assert.equal(!made.ok && made.error.reason, 'worktree-mismatch');
}));

test('commits as an actor carry its trailers and are refused off its branch', withTestVault(async (v) => {
  const accepted = v.accept();
  const made = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
  assert.ok(made.ok);
  const worktree = made.value.path;
  writeIn(worktree, 'notes/a.md');
  const committed = await commitAsActor(v.git, worktree, {
    origin: { trace: '01TRACE', actor: 'gardener', session: 'S1' },
    message: 'Add a note',
    date: v.clock.now(),
  });
  assert.ok(committed.ok);
  assert.match(v.repo.git('log', '-1', '--format=%B', committed.value), /Vault-Trace: 01TRACE\nVault-Actor: gardener\nVault-Session: S1/);
  writeIn(worktree, 'notes/b.md');
  const wrongActor = await commitAsActor(v.git, worktree, { origin: { trace: 'T', actor: 'librarian' }, message: 'x', date: v.clock.now() });
  assert.equal(!wrongActor.ok && wrongActor.error.reason, 'wrong-branch');
  v.repo.write('c.md', 'c');
  const onMain = await commitAsActor(v.git, v.repo.path, { origin: { trace: 'T', actor: 'gardener' }, message: 'x', date: v.clock.now() });
  assert.equal(!onMain.ok && onMain.error.reason, 'wrong-branch');
}));

function writeIn(root: string, path: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, path);
}
