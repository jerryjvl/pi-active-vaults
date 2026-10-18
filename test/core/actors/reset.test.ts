// Documented behaviour: daemon.md "Forge sync" — after a squash or rebase merge
// the actor's branch still holds the commits `main` does not contain. It is
// reset to the accepted main only when all hold: its tip is exactly the head
// that was approved, no session holds the actor, and its worktree is clean
// (untracked files included). Otherwise it is left as it is, and the outcome
// says which condition stopped the reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureActorWorktree, resetActorBranch, takeActorHold } from '../../../src/core/actors/index.ts';
import type { ProcessLiveness } from '../../../src/core/process/index.ts';
import { withTestVault, type TestVault } from '../../support/vault.ts';

const running = (live: Record<number, string>): ProcessLiveness => async (pid) => ({ ok: true, value: live[pid] });
const context = (v: TestVault, alive: ProcessLiveness = running({})) => ({ git: v.git, store: v.store, alive });
const BRANCH = 'refs/heads/actor/gardener';

/** The proposal's head, and the accepted main after a squash merge replaced its commits with one. */
function squashed(v: TestVault): { head: string; accepted: ReturnType<TestVault['accept']> } {
  v.accept();
  const head = v.propose({ 'notes/a.md': 'A' });
  v.repo.write('notes/a.md', 'A');
  v.repo.commit('Squashed: Proposal (#1)');
  return { head, accepted: v.accept() };
}

test('a branch holding exactly the approved head is reset to the accepted main: its ref when it has no worktree, the worktree when it has one', withTestVault(async (v) => {
  const { head, accepted } = squashed(v);
  const reset = await resetActorBranch(context(v), v.vault, accepted, 'gardener', head);
  assert.deepEqual(reset, { ok: true, value: { outcome: 'reset', head: accepted.sha } });
  assert.equal(v.repo.git('rev-parse', BRANCH), accepted.sha);

  v.propose({ 'notes/b.md': 'B' });
  const tip = v.repo.git('rev-parse', BRANCH);
  const made = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
  assert.ok(made.ok);
  const checkedOut = await resetActorBranch(context(v), v.vault, accepted, 'gardener', tip);
  assert.deepEqual(checkedOut, { ok: true, value: { outcome: 'reset', head: accepted.sha } });
  assert.equal(v.repo.git('rev-parse', BRANCH), accepted.sha);
  assert.equal(readFileSync(join(made.value.path, 'notes', 'a.md'), 'utf8'), 'A');
  assert.equal(existsSync(join(made.value.path, 'notes', 'b.md')), false, 'the worktree follows the branch');
}));

test('a branch whose tip is not exactly the approved head — work was added after it — is left',withTestVault(async (v) => {
  const { head, accepted } = squashed(v);
  const later = v.propose({ 'notes/later.md': 'more' });
  const moved = await resetActorBranch(context(v), v.vault, accepted, 'gardener', head);
  assert.deepEqual(moved, { ok: true, value: { outcome: 'moved', head: later } });
  assert.equal(v.repo.git('rev-parse', BRANCH), later);
}));

test('a branch that does not exist is nothing to reset', withTestVault(async (v) => {
  const accepted = v.accept();
  assert.deepEqual(await resetActorBranch(context(v), v.vault, accepted, 'gardener', v.initial), { ok: true, value: { outcome: 'no-branch' } });
}));

test('a branch whose actor is held by a session is left, whoever the session is; once the session has ended it is reset', withTestVault(async (v) => {
  const { head, accepted } = squashed(v);
  const holder = { process: { pid: 7, started: 's' }, session: 'S' };
  assert.ok((await takeActorHold(v.store, running({ 7: 's' }), v.clock, { vault: v.vault.id, actor: 'gardener', holder })).ok);
  const busy = await resetActorBranch(context(v, running({ 7: 's' })), v.vault, accepted, 'gardener', head);
  assert.ok(busy.ok && busy.value.outcome === 'actor-busy');
  assert.equal(v.repo.git('rev-parse', BRANCH), head);

  const ended = await resetActorBranch(context(v, running({})), v.vault, accepted, 'gardener', head);
  assert.deepEqual(ended, { ok: true, value: { outcome: 'reset', head: accepted.sha } });
}));

for (const [what, change] of [
  ['a tracked change', (dir: string) => writeFileSync(join(dir, 'notes', 'a.md'), 'edited')],
  ['an untracked file', (dir: string) => writeFileSync(join(dir, 'scratch.md'), 'draft')],
] as const) {
  test(`a branch whose worktree has ${what} is left as it is`, withTestVault(async (v) => {
    const { head, accepted } = squashed(v);
    const made = await ensureActorWorktree(v.git, v.vault, accepted, 'gardener');
    assert.ok(made.ok);
    change(made.value.path);
    const dirty = await resetActorBranch(context(v), v.vault, accepted, 'gardener', head);
    assert.deepEqual(dirty, { ok: true, value: { outcome: 'uncommitted-changes', head } });
    assert.equal(v.repo.git('rev-parse', BRANCH), head);
  }));
}
