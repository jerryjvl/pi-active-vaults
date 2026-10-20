// Documented behaviour: daemon.md "Forge sync" — a pull request merged without
// its commits is reported with what to do: reset its branch to main, given as
// commands in the directory they are for (its worktree, or the vault's clone
// when no worktree has it checked out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lostMergeNotice, lostMergeReport } from '../../../src/core/forge/index.ts';

const lost = { vault: 'home', pull: 7, url: '', actor: 'gardener', head: 'a'.repeat(40), main: 'b'.repeat(40), kept: false, at: '2026-10-21T00:00:00Z' };
const vault = { id: 'home', path: '/srv/vaults/home' };

test('a lost merge whose branch is checked out says to reset it there, after checking for uncommitted work', () => {
  const report = lostMergeReport({ ...lost, checkout: '/state/worktrees/home/gardener' }, vault);
  assert.ok(report.includes('  cd /state/worktrees/home/gardener\n  git status\n  git reset --hard main'), report);
});

test('a lost merge whose branch is checked out nowhere says to move it in the vault\'s clone', () => {
  const report = lostMergeReport(lost, vault);
  assert.ok(report.includes('  cd /srv/vaults/home\n  git branch -f actor/gardener main'), report);
});

test('a lost merge left as it was for uncommitted work names that worktree in its steps', () => {
  const notice = lostMergeNotice(lost, vault, { outcome: 'uncommitted-changes', head: lost.head }, { ...lost, checkout: '/state/worktrees/home/gardener' });
  assert.match(notice, /its worktree has uncommitted changes/);
  assert.ok(notice.includes('cd /state/worktrees/home/gardener'), notice);
});
