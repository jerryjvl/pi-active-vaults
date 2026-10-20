// Documented behaviour: an error that asks a person to act on a worktree by
// hand names it and gives the commands, with the `cd` to it first (cli.md
// "vault commit", "vault sync").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../../../src/core/operations/messages.ts';

const repo = '/state/worktrees/home/gardener';

test('uncommitted changes name the worktree and how to see them', () => {
  const text = describeError({ reason: 'dirty-worktree', repo });
  assert.ok(text.includes(`  cd ${repo}\n  git status`), text);
});

test('unresolved conflicts in a merge name the worktree, the files, and how to finish or back out', () => {
  const text = describeError({ reason: 'unresolved-conflicts', paths: ['notes/a.md', 'notes/my b.md'], repo });
  assert.ok(text.includes(`  cd ${repo}\n  git status\n  git add notes/a.md 'notes/my b.md'`), text);
  assert.ok(text.includes('git merge --abort'), text);
});

test('a partial commit during a merge names the worktree and says to commit it whole', () => {
  const text = describeError({ reason: 'merge-in-progress', repo });
  assert.ok(text.includes(`cd ${repo}`), text);
  assert.match(text, /no paths/);
});

test('a worktree on the wrong branch names it and the branch to switch to', () => {
  const text = describeError({ reason: 'wrong-branch', expected: 'actor/gardener', actual: 'main', worktree: repo });
  assert.ok(text.includes(`  cd ${repo}\n  git status\n  git switch actor/gardener`), text);
});
