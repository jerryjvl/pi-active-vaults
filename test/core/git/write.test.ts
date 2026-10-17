// Documented behaviour: commits carry trailers and the actor's identity; accept
// merges the reviewed SHA only (never a branch name) and never into a dirty
// tree; a conflict leaves the repository as it was (security.md, AGENTS.md §6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addTrailers,
  commitsBetween,
  createCommit,
  hasTrackedChanges,
  mergeSha,
} from '../../../src/core/git/index.ts';
import { gitFor, withTempRepo, type TempRepo } from '../../support/git-repo.ts';

const BOB = { name: 'Bob Builder', email: 'bob@example.net' };

test('trailers are appended to a message, replacing an existing trailer of the same key', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const once = await addTrailers(git, 'Subject\n\nBody.', [
    { key: 'Vault-Trace', value: 'T1' },
    { key: 'Vault-Actor', value: 'gardener' },
  ]);
  assert.ok(once.ok);
  assert.match(once.value, /^Subject\n\nBody\.\n\nVault-Trace: T1\nVault-Actor: gardener\n$/);
  const twice = await addTrailers(git, once.value, [{ key: 'Vault-Trace', value: 'T2' }]);
  assert.ok(twice.ok);
  assert.equal(twice.value.match(/Vault-Trace/g)?.length, 1);
  assert.match(twice.value, /Vault-Trace: T2/);
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
    const result = await addTrailers(git, 'Subject', [trailer]);
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
