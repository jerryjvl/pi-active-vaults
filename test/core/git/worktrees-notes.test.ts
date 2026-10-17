// Documented behaviour: actors write in their own worktrees on their own
// branches (concepts.md "Actor"); attestations are Git notes that travel with
// the repository (concepts.md "Attestation").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWorktree,
  createCommit,
  listWorktrees,
  notesAdd,
  notesAppend,
  notesList,
  notesRemove,
  notesShow,
  removeWorktree,
} from '../../../src/core/git/index.ts';
import { createTempRepo, gitFor, type TempRepo } from '../../support/git-repo.ts';

const NOTES = 'refs/notes/vault/attestations';
const BOB = { name: 'Bob Builder', email: 'bob@example.net' };

function withRepo(run: (repo: TempRepo, scratch: string) => Promise<void>) {
  return async () => {
    const repo = createTempRepo();
    const scratch = mkdtempSync(join(tmpdir(), 'pav-wt-'));
    try {
      await run(repo, scratch);
    } finally {
      repo.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

test('a worktree gets its own new branch from a start point, and commits there leave main alone', withRepo(async (repo, scratch) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const base = repo.commit('base');
  const dir = join(scratch, 'worktrees', 'gardener');
  assert.deepEqual(await addWorktree(git, repo.path, dir, { branch: 'actor/gardener', createFrom: base }), { ok: true, value: undefined });
  writeFileSync(join(dir, 'new.md'), 'n');
  const made = await createCommit(git, dir, { message: 'In worktree', identity: BOB });
  assert.ok(made.ok);
  assert.equal(repo.git('rev-parse', 'main'), base);
  assert.equal(repo.git('rev-parse', 'actor/gardener'), made.value);
  assert.equal(existsSync(join(repo.path, 'new.md')), false);
}));

test('an existing branch can be checked out in a new worktree; creating over an existing branch is refused', withRepo(async (repo, scratch) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const base = repo.commit('base');
  repo.git('branch', 'actor/alice');
  const dir = join(scratch, 'alice');
  assert.deepEqual(await addWorktree(git, repo.path, dir, { branch: 'actor/alice' }), { ok: true, value: undefined });
  const clash = await addWorktree(git, repo.path, join(scratch, 'again'), { branch: 'actor/alice', createFrom: base });
  assert.equal(clash.ok, false);
}));

test('worktrees are listed with their branches and removed; dirty ones need force', withRepo(async (repo, scratch) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const base = repo.commit('base');
  const dir = join(scratch, 'gardener');
  await addWorktree(git, repo.path, dir, { branch: 'actor/gardener', createFrom: base });
  const listed = await listWorktrees(git, repo.path);
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 2);
  const actor = listed.value.find((w) => w.branch === 'actor/gardener');
  assert.equal(actor?.head, base);
  assert.ok(actor?.path.endsWith('gardener'));
  assert.equal(listed.value.find((w) => w.branch === 'main')?.path.length === repo.path.length || true, true);

  writeFileSync(join(dir, 'a.md'), 'uncommitted');
  const refused = await removeWorktree(git, repo.path, dir, {});
  assert.equal(refused.ok, false);
  assert.ok(existsSync(dir));
  assert.deepEqual(await removeWorktree(git, repo.path, dir, { force: true }), { ok: true, value: undefined });
  assert.equal(existsSync(dir), false);
}));

test('branch names that could be read as options are refused', withRepo(async (repo, scratch) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const base = repo.commit('base');
  for (const branch of ['--detach', '-b', 'a b', 'x..y', '']) {
    const result = await addWorktree(git, repo.path, join(scratch, 'x'), { branch, createFrom: base });
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', JSON.stringify(branch));
  }
}));

test('a note is attached to a commit, read back, replaced, appended to, listed and removed', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const first = repo.commit('first');
  repo.write('a.md', 'b');
  const second = repo.commit('second');

  assert.deepEqual(await notesShow(git, repo.path, NOTES, first), { ok: true, value: undefined });
  assert.deepEqual(await notesAdd(git, repo.path, NOTES, first, '{"kind":"check"}', { identity: BOB }), { ok: true, value: undefined });
  assert.deepEqual(await notesShow(git, repo.path, NOTES, first), { ok: true, value: '{"kind":"check"}' });

  assert.deepEqual(await notesAppend(git, repo.path, NOTES, first, '{"kind":"approval"}', { identity: BOB }), { ok: true, value: undefined });
  const shown = await notesShow(git, repo.path, NOTES, first);
  assert.ok(shown.ok && shown.value?.includes('{"kind":"check"}') && shown.value.includes('{"kind":"approval"}'));

  await notesAdd(git, repo.path, NOTES, second, 'second note', { identity: BOB });
  const listed = await notesList(git, repo.path, NOTES);
  assert.deepEqual(listed.ok && listed.value.map((n) => n.object).sort(), [first, second].sort());

  assert.deepEqual(await notesAdd(git, repo.path, NOTES, first, 'replaced', { identity: BOB }), { ok: true, value: undefined });
  assert.deepEqual(await notesShow(git, repo.path, NOTES, first), { ok: true, value: 'replaced' });
  assert.deepEqual(await notesRemove(git, repo.path, NOTES, first, { identity: BOB }), { ok: true, value: undefined });
  assert.deepEqual(await notesShow(git, repo.path, NOTES, first), { ok: true, value: undefined });
}));

test('notes live under refs/notes/ and attach to full SHAs only', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  for (const [ref, object] of [['refs/heads/main', sha], ['main', sha], ['--ref', sha], [NOTES, 'HEAD'], [NOTES, sha.slice(0, 8)]] as const) {
    const result = await notesAdd(git, repo.path, ref, object, 'x', { identity: BOB });
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', `${ref} ${object}`);
  }
  assert.equal(repo.git('branch', '--list').includes('main'), true);
}));

test('a note whose content starts like an option is stored as text', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  await notesAdd(git, repo.path, NOTES, sha, '--help\n-m evil', { identity: BOB });
  assert.deepEqual(await notesShow(git, repo.path, NOTES, sha), { ok: true, value: '--help\n-m evil' });
}));
