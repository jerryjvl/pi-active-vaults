// Documented behaviour: core.md "git" and security.md — history, diffs and file
// content are read from a given revision (never the working tree), because
// executable and instructional content comes only from the accepted `main`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  changedPaths,
  commitsBetween,
  diffText,
  listFiles,
  readFileAt,
} from '../../../src/core/git/index.ts';
import { createTempRepo, gitFor, type TempRepo } from '../../support/git-repo.ts';

function withRepo(run: (repo: TempRepo) => Promise<void>) {
  return async () => {
    const repo = createTempRepo();
    try {
      await run(repo);
    } finally {
      repo.cleanup();
    }
  };
}

test('commits in a range come oldest first with author, parents, message and trailers', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const base = repo.commit('base');
  repo.write('a.md', 'b');
  const second = repo.commit('Second change\n\nBody text.\n\nVault-Trace: 01TRACE\nVault-Actor: gardener');
  repo.write('a.md', 'c');
  const third = repo.commit('Third');
  const result = await commitsBetween(git, repo.path, base, third);
  assert.ok(result.ok);
  assert.deepEqual(result.value.map((c) => c.sha), [second, third]);
  const [c2, c3] = result.value;
  assert.equal(c2?.subject, 'Second change');
  assert.deepEqual(c2?.parents, [base]);
  assert.deepEqual(c2?.author, { name: 'Alice', email: 'alice@example.net' });
  assert.match(c2?.message ?? '', /^Second change\n\nBody text\./);
  assert.deepEqual(c2?.trailers, [
    { key: 'Vault-Trace', value: '01TRACE' },
    { key: 'Vault-Actor', value: 'gardener' },
  ]);
  assert.deepEqual(c3?.trailers, []);
  assert.ok(c3?.date instanceof Date && !Number.isNaN(c3.date.getTime()));
}));

test('a range from nothing covers all history, and an identical range is empty', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const first = repo.commit('first');
  repo.write('a.md', 'b');
  const second = repo.commit('second');
  const all = await commitsBetween(git, repo.path, null, second);
  assert.deepEqual(all.ok && all.value.map((c) => c.sha), [first, second]);
  const none = await commitsBetween(git, repo.path, second, second);
  assert.deepEqual(none, { ok: true, value: [] });
}));

test('changed paths report created, modified, deleted and renamed files', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('keep.md', 'keep\n');
  repo.write('edit.md', 'one\n');
  repo.write('gone.md', 'bye\n');
  repo.write('old-name.md', 'a long enough body to be recognised as the same file after a rename\n'.repeat(3));
  const base = repo.commit('base');
  repo.write('edit.md', 'two\n');
  repo.write('new.md', 'hello\n');
  repo.git('rm', '--quiet', 'gone.md');
  repo.git('mv', 'old-name.md', 'topics/new-name.md');
  const head = repo.commit('mixed');
  const result = await changedPaths(git, repo.path, base, head);
  assert.ok(result.ok);
  const sorted = [...result.value].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(sorted, [
    { change: 'modified', path: 'edit.md' },
    { change: 'deleted', path: 'gone.md' },
    { change: 'created', path: 'new.md' },
    { change: 'renamed', path: 'topics/new-name.md', oldPath: 'old-name.md' },
  ]);
}));

test('paths with spaces and non-ASCII names come back exactly', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('seed.md', 's');
  const base = repo.commit('base');
  repo.write('notes/café au lait.md', 'x');
  const head = repo.commit('add');
  const result = await changedPaths(git, repo.path, base, head);
  assert.deepEqual(result, { ok: true, value: [{ change: 'created', path: 'notes/café au lait.md' }] });
}));

test('from nothing, every file is created', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.write('dir/b.md', 'b');
  const head = repo.commit('all');
  const result = await changedPaths(git, repo.path, null, head);
  assert.deepEqual(result.ok && result.value.map((c) => `${c.change}:${c.path}`).sort(), ['created:a.md', 'created:dir/b.md']);
}));

test('the diff text between revisions is returned, and never runs configured external programs', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'one\n');
  repo.write('.gitattributes', '*.md diff=sneaky\n');
  const base = repo.commit('base');
  repo.write('a.md', 'two\n');
  const head = repo.commit('change');
  const marker = join(repo.path, '..', `marker-${process.pid}`);
  repo.git('config', 'diff.external', `touch ${marker} #`);
  repo.git('config', 'diff.sneaky.textconv', `touch ${marker} #`);
  const result = await diffText(git, repo.path, base, head);
  assert.ok(result.ok);
  assert.match(result.value, /-one\n\+two\n/);
  assert.equal(existsSync(marker), false, 'external diff or textconv ran');
}));

test('files are listed and read from the revision, not the working tree', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('.vault/scripts/run.sh', '#!/bin/sh\necho trusted\n');
  repo.write('doc.md', 'committed\n');
  const sha = repo.commit('accepted');
  // The working tree now differs from the commit: edited, plus an uncommitted file.
  writeFileSync(join(repo.path, '.vault/scripts/run.sh'), '#!/bin/sh\necho tampered\n');
  repo.write('untracked.md', 'x');
  const files = await listFiles(git, repo.path, sha);
  assert.deepEqual(files, { ok: true, value: ['.vault/scripts/run.sh', 'doc.md'] });
  const script = await readFileAt(git, repo.path, sha, '.vault/scripts/run.sh');
  assert.equal(script.ok && script.value.toString('utf8'), '#!/bin/sh\necho trusted\n');
}));

test('binary content is returned byte for byte', withRepo(async (repo) => {
  const git = gitFor(repo);
  const bytes = Buffer.from([0, 255, 254, 10, 13, 128]);
  writeFileSync(join(repo.path, 'blob.bin'), bytes);
  const sha = repo.commit('binary');
  const read = await readFileAt(git, repo.path, sha, 'blob.bin');
  assert.ok(read.ok && Buffer.compare(read.value, bytes) === 0);
}));

test('a missing file and a missing revision are different errors', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  assert.deepEqual(await readFileAt(git, repo.path, sha, 'missing.md'), {
    ok: false,
    error: { reason: 'not-found', path: 'missing.md' },
  });
  const unknown = await readFileAt(git, repo.path, 'nope', 'a.md');
  assert.equal(unknown.ok === false && unknown.error.reason, 'unknown-revision');
}));

test('paths that escape or are absolute are refused', withRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  for (const bad of ['../a.md', '/etc/passwd', 'a/../a.md', './a.md', '', 'a\0b', 'a\\..\\b']) {
    const result = await readFileAt(git, repo.path, sha, bad);
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', JSON.stringify(bad));
  }
}));
