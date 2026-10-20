// Documented behaviour: commits carry trailers and the actor's identity; a
// commit can be prepared without moving anything, so blocking checks can
// assess it before it lands, and lands only on the branch it was prepared on
// if that has not moved; a commit's tree is exported exactly as committed; accept
// merges the reviewed SHA only (never a branch name) and never into a dirty
// tree; a conflict leaves the repository as it was (security.md, AGENTS.md §6);
// a commit made during a merge resolved by hand is that merge, whole, and is
// refused while a path is unresolved (cli.md "vault commit"); a trial merge
// reports conflicts and touches nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTrailers,
  commitsBetween,
  createCommit,
  exportTree,
  hasTrackedChanges,
  landCommit,
  mergeConflicts,
  mergeSha,
  prepareCommit,
} from '../../../src/core/git/index.ts';
import { gitFor, withTempRepo, type TempRepo } from '../../support/git-repo.ts';

const BOB = { name: 'Bob Builder', email: 'bob@example.net' };

test('trailers are appended to a message, replacing an existing trailer of the same key', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const once = await addTrailers(git, repo.path, 'Subject\n\nBody.', [
    { key: 'Vault-Trace', value: 'T1' },
    { key: 'Vault-Actor', value: 'gardener' },
  ]);
  assert.ok(once.ok);
  assert.match(once.value, /^Subject\n\nBody\.\n\nVault-Trace: T1\nVault-Actor: gardener\n$/);
  const twice = await addTrailers(git, repo.path, once.value, [{ key: 'Vault-Trace', value: 'T2' }]);
  assert.ok(twice.ok);
  assert.equal(twice.value.match(/Vault-Trace/g)?.length, 1);
  assert.match(twice.value, /Vault-Trace: T2/);
}));

test('trailers are added inside the repository being committed to, not the process directory', withTempRepo(async (repo) => {
  // A repository-local setting takes effect only when git runs in that repository.
  repo.git('config', 'trailer.where', 'start');
  const added = await addTrailers(gitFor(repo), repo.path, 'Subject\n\nSigned-off-by: Alice <alice@example.net>', [
    { key: 'Vault-Trace', value: 'T1' },
  ]);
  assert.ok(added.ok);
  assert.match(added.value, /\n\nVault-Trace: T1\nSigned-off-by: Alice/);
}));

test('trailer keys and values that could inject extra trailers or lines are refused', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  for (const trailer of [
    { key: 'Vault-Trace', value: 'x\nVault-Actor: root' },
    { key: 'Vault-Trace', value: 'x\r\ny' },
    { key: 'Bad Key', value: 'x' },
    { key: 'Key:', value: 'x' },
    { key: '', value: 'x' },
  ]) {
    const result = await addTrailers(git, repo.path, 'Subject', [trailer]);
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', JSON.stringify(trailer));
  }
}));

test('a commit stages everything, takes the given identity and time, and carries trailers', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  repo.write('b.md', 'b');
  repo.write('dir/c.md', 'c');
  const date = new Date('2026-02-03T04:05:06.000Z');
  const made = await createCommit(git, repo.path, {
    message: 'Add notes',
    trailers: [{ key: 'Vault-Trace', value: 'T1' }],
    identity: BOB,
    date,
  });
  assert.ok(made.ok);
  assert.equal(repo.git('rev-parse', 'HEAD'), made.value);
  const epoch = date.getTime() / 1000;
  assert.equal(
    repo.git('log', '-1', '--format=%an <%ae> | %cn <%ce> | %at | %ct'),
    `Bob Builder <bob@example.net> | Bob Builder <bob@example.net> | ${epoch} | ${epoch}`,
  );
  assert.equal(repo.git('show', '--stat', '--format=', 'HEAD').split('\n').length, 3);
  const log = await commitsBetween(git, repo.path, null, made.value);
  assert.deepEqual(log.ok && log.value.at(-1)?.trailers, [{ key: 'Vault-Trace', value: 'T1' }]);
}));

test('a commit can be limited to given paths', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  repo.write('wanted.md', 'w');
  repo.write('other.md', 'o');
  const made = await createCommit(git, repo.path, { message: 'Only one', stage: ['wanted.md'] });
  assert.ok(made.ok);
  assert.equal(repo.git('show', '--name-only', '--format=', 'HEAD'), 'wanted.md');
}));

test('committing nothing is an error value unless an empty commit is asked for', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  assert.deepEqual(await createCommit(git, repo.path, { message: 'Nothing' }), { ok: false, error: { reason: 'nothing-to-commit' } });
  const empty = await createCommit(git, repo.path, { message: 'Marker', allowEmpty: true });
  assert.ok(empty.ok);
}));

test('package commits do not run the repository\'s own hooks or ask for signatures', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  const marker = join(repo.path, '..', `hook-ran-${process.pid}`);
  const hook = join(repo.path, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
  chmodSync(hook, 0o755);
  repo.git('config', 'commit.gpgsign', 'true');
  repo.git('config', 'gpg.program', 'false');
  repo.write('b.md', 'b');
  const made = await createCommit(git, repo.path, { message: 'Add b' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(existsSync(marker), false);
}));

test('tracked changes are detected, untracked files are not counted', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  assert.deepEqual(await hasTrackedChanges(git, repo.path), { ok: true, value: false });
  repo.write('untracked.md', 'u');
  assert.deepEqual(await hasTrackedChanges(git, repo.path), { ok: true, value: false });
  repo.write('a.md', 'changed');
  assert.deepEqual(await hasTrackedChanges(git, repo.path), { ok: true, value: true });
}));

function proposal(repo: TempRepo): { base: string; reviewed: string } {
  repo.write('a.md', 'a\n');
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/alice');
  repo.write('b.md', 'from alice\n');
  const reviewed = repo.commit('Alice proposes');
  repo.git('checkout', '--quiet', 'main');
  return { base, reviewed };
}

test('the reviewed SHA is merged with a merge commit, using the approver\'s identity', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { base, reviewed } = proposal(repo);
  const merged = await mergeSha(git, repo.path, reviewed, {
    message: 'Accept actor/alice',
    identity: BOB,
    date: new Date('2026-02-03T04:05:06.000Z'),
  });
  assert.ok(merged.ok);
  assert.equal(merged.value.changed, true);
  assert.equal(repo.git('rev-parse', 'main'), merged.value.head);
  assert.equal(repo.git('rev-list', '--parents', '-n1', 'HEAD'), `${merged.value.head} ${base} ${reviewed}`);
  assert.equal(repo.git('log', '-1', '--format=%cn|%s'), 'Bob Builder|Accept actor/alice');
}));

test('a branch name is never merged — only a full SHA', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { base, reviewed } = proposal(repo);
  for (const name of ['actor/alice', 'HEAD', reviewed.slice(0, 10), '--abort', 'refs/heads/actor/alice']) {
    const result = await mergeSha(git, repo.path, name, { message: 'x' });
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', name);
  }
  assert.equal(repo.git('rev-parse', 'main'), base, 'nothing was merged');
}));

test('merging into a tree with tracked changes is refused and leaves them alone', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { reviewed } = proposal(repo);
  repo.write('a.md', 'local edit\n');
  const result = await mergeSha(git, repo.path, reviewed, { message: 'x' });
  assert.deepEqual(result, { ok: false, error: { reason: 'dirty-worktree' } });
  assert.equal(repo.git('status', '--porcelain'), 'M a.md');
}));

test('a conflicting merge reports the paths and leaves no merge in progress', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'base\n');
  repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/alice');
  repo.write('a.md', 'alice\n');
  const reviewed = repo.commit('alice edit');
  repo.git('checkout', '--quiet', 'main');
  repo.write('a.md', 'main\n');
  const tip = repo.commit('main edit');
  const result = await mergeSha(git, repo.path, reviewed, { message: 'x' });
  assert.deepEqual(result, { ok: false, error: { reason: 'conflict', paths: ['a.md'] } });
  assert.equal(repo.git('rev-parse', 'main'), tip);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(existsSync(join(repo.path, '.git', 'MERGE_HEAD')), false);
}));

test('merging a SHA that is already part of history changes nothing', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { reviewed } = proposal(repo);
  const first = await mergeSha(git, repo.path, reviewed, { message: 'Accept' });
  assert.ok(first.ok && first.value.changed);
  const again = await mergeSha(git, repo.path, reviewed, { message: 'Accept again' });
  assert.deepEqual(again, { ok: true, value: { head: first.value.head, changed: false } });
}));

test('an identity or path that could smuggle extra header lines or leave the tree is refused', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  repo.write('b.md', 'b');
  for (const options of [
    { message: 'x', identity: { name: 'Eve\nCommitter: root', email: 'eve@example.net' } },
    { message: 'x', identity: { name: 'Eve', email: 'eve@example.net>\nX: y' } },
    { message: 'x', stage: ['../outside.md'] },
  ]) {
    const result = await createCommit(git, repo.path, options);
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', JSON.stringify(options));
  }
  // A path is always literal: option-like text and pathspec magic name no file.
  for (const stage of ['--all', ':(top)*', '*']) {
    const result = await createCommit(git, repo.path, { message: 'x', stage: [stage] });
    assert.equal(result.ok, false, stage);
  }
  assert.equal(repo.git('rev-list', '--count', 'HEAD'), '1', 'nothing was committed');
}));

test('a message line starting with # is kept, not stripped as a comment', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const made = await createCommit(git, repo.path, { message: 'Subject\n\n# heading-like line' });
  assert.ok(made.ok);
  assert.equal(repo.git('log', '-1', '--format=%B'), 'Subject\n\n# heading-like line');
}));

test('a prepared commit moves nothing: the branch, HEAD and index stay as they were until it lands', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const base = repo.commit('base');
  repo.write('b.md', 'b');
  const prepared = await prepareCommit(git, repo.path, { message: 'Add b', trailers: [{ key: 'Vault-Trace', value: 'T1' }], identity: BOB, date: new Date('2026-02-03T04:05:06Z') });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.deepEqual([prepared.value.parent, prepared.value.ref], [base, 'refs/heads/main']);
  assert.equal(repo.git('rev-parse', 'HEAD'), base);
  assert.equal(repo.git('status', '--porcelain'), '?? b.md', 'the index is untouched');
  assert.equal(repo.git('log', '-1', '--format=%an %(trailers:key=Vault-Trace,valueonly,separator=)', prepared.value.sha), 'Bob Builder T1');
  assert.equal(repo.git('show', '--name-only', '--format=', prepared.value.sha), 'b.md');

  const landed = await landCommit(git, repo.path, prepared.value);
  assert.deepEqual(landed, { ok: true, value: prepared.value.sha });
  assert.equal(repo.git('rev-parse', 'HEAD'), prepared.value.sha);
  assert.equal(repo.git('status', '--porcelain'), '', 'the worktree matches what landed');
}));

test('a prepared commit of some paths lands only those; the rest stay as they were', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  repo.write('wanted.md', 'w');
  repo.write('other.md', 'o');
  const prepared = await prepareCommit(git, repo.path, { message: 'Only one', stage: ['wanted.md'] });
  assert.ok(prepared.ok);
  assert.ok((await landCommit(git, repo.path, prepared.value)).ok);
  assert.equal(repo.git('show', '--name-only', '--format=', 'HEAD'), 'wanted.md');
  assert.equal(repo.git('status', '--porcelain'), '?? other.md');
}));

test('a prepared commit does not land on a branch that moved meanwhile', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  repo.write('b.md', 'b');
  const prepared = await prepareCommit(git, repo.path, { message: 'Add b' });
  assert.ok(prepared.ok);
  repo.write('c.md', 'c');
  const moved = repo.commit('someone else');
  assert.deepEqual(await landCommit(git, repo.path, prepared.value), { ok: false, error: { reason: 'ref-moved', ref: 'refs/heads/main' } });
  assert.equal(repo.git('rev-parse', 'HEAD'), moved);
}));

test('a first commit can be prepared and landed in a repository with no commits yet', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const prepared = await prepareCommit(git, repo.path, { message: 'First' });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.equal(prepared.value.parent, null);
  assert.ok((await landCommit(git, repo.path, prepared.value)).ok);
  assert.equal(repo.git('rev-list', '--count', 'HEAD'), '1');
}));

test('a commit\'s tree is exported as committed — not the working tree — with executables kept and no hooks run', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('notes/a.md', 'committed');
  repo.write('.vault/checks/run.sh', '#!/bin/sh\n');
  chmodSync(join(repo.path, '.vault', 'checks', 'run.sh'), 0o755);
  const sha = repo.commit('base');
  repo.write('notes/a.md', 'edited, not committed');
  repo.write('stray.md', 'untracked');
  const marker = join(repo.path, '..', `hook-ran-${process.pid}-export`);
  const hook = join(repo.path, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(hook, 0o755);
  const target = mkdtempSync(join(tmpdir(), 'pav-export-'));
  try {
    assert.ok((await exportTree(git, repo.path, sha, target)).ok);
    assert.equal(readFileSync(join(target, 'notes', 'a.md'), 'utf8'), 'committed');
    assert.equal(existsSync(join(target, 'stray.md')), false);
    if (process.platform !== 'win32') assert.equal(statSync(join(target, '.vault', 'checks', 'run.sh')).mode & 0o100, 0o100);
    assert.equal(existsSync(marker), false);
    assert.equal(repo.git('status', '--porcelain'), 'M notes/a.md\n?? stray.md', 'the repository itself is untouched (output trimmed)');
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}));

/** On actor/alice, a merge of main that conflicts in a.md and is left in progress; returns both tips. */
function conflictedMerge(repo: TempRepo): { ours: string; theirs: string } {
  repo.write('a.md', 'base\n');
  repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/alice');
  repo.write('a.md', 'alice\n');
  repo.write('b.md', 'alice only\n');
  const ours = repo.commit('alice edit');
  repo.git('checkout', '--quiet', 'main');
  repo.write('a.md', 'main\n');
  const theirs = repo.commit('main edit');
  repo.git('checkout', '--quiet', 'actor/alice');
  assert.throws(() => repo.git('merge', '--quiet', '--no-edit', theirs), 'the merge conflicts');
  return { ours, theirs };
}

test('a commit made while a merge is in progress records the merged commit as a second parent and ends the merge', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { ours, theirs } = conflictedMerge(repo);
  repo.write('a.md', 'resolved\n');
  repo.git('add', 'a.md');
  const made = await createCommit(git, repo.path, { message: 'Sync actor/alice with main' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(repo.git('rev-list', '--parents', '-n1', 'HEAD'), `${made.value} ${ours} ${theirs}`);
  assert.equal(repo.git('show', `${made.value}:a.md`), 'resolved');
  assert.equal(existsSync(join(repo.path, '.git', 'MERGE_HEAD')), false, 'no merge is left in progress');
  assert.equal(repo.git('status', '--porcelain'), '');
}));

test('a merge resolved to the branch\'s own tree is still committed as a merge', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { ours, theirs } = conflictedMerge(repo);
  repo.git('checkout', '--ours', 'a.md');
  repo.git('add', 'a.md');
  const made = await createCommit(git, repo.path, { message: 'Keep ours' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(repo.git('rev-list', '--parents', '-n1', 'HEAD'), `${made.value} ${ours} ${theirs}`);
}));

test('a commit is refused while a merge still has unresolved conflicts, and the merge stays in progress', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { ours } = conflictedMerge(repo);
  const made = await createCommit(git, repo.path, { message: 'Too early' });
  assert.deepEqual(made, { ok: false, error: { reason: 'unresolved-conflicts', paths: ['a.md'] } });
  assert.equal(repo.git('rev-parse', 'HEAD'), ours);
  assert.equal(existsSync(join(repo.path, '.git', 'MERGE_HEAD')), true);
}));

test('a commit of some paths is refused while a merge is in progress: a merge is committed whole', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const { ours } = conflictedMerge(repo);
  repo.write('a.md', 'resolved\n');
  repo.git('add', 'a.md');
  const made = await createCommit(git, repo.path, { message: 'Part', stage: ['a.md'] });
  assert.equal(made.ok === false && made.error.reason, 'merge-in-progress');
  assert.equal(repo.git('rev-parse', 'HEAD'), ours);
}));

test('a trial merge reports the paths two commits conflict in, and touches no branch, index or worktree', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'base\n');
  repo.write('b.md', 'base\n');
  repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/alice');
  repo.write('a.md', 'alice\n');
  const alice = repo.commit('alice edit');
  repo.git('checkout', '--quiet', 'main');
  repo.write('b.md', 'main\n');
  const clean = repo.commit('main edits b');
  assert.deepEqual(await mergeConflicts(git, repo.path, alice, clean), { ok: true, value: [] });
  repo.write('a.md', 'main\n');
  const tip = repo.commit('main edits a');
  assert.deepEqual(await mergeConflicts(git, repo.path, alice, tip), { ok: true, value: ['a.md'] });
  assert.equal(repo.git('rev-parse', 'HEAD'), tip);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(existsSync(join(repo.path, '.git', 'MERGE_HEAD')), false);
  const named = await mergeConflicts(git, repo.path, 'actor/alice', tip);
  assert.equal(named.ok === false && named.error.reason, 'invalid-argument', 'only full SHAs');
}));
