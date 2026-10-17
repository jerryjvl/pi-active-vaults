// Documented behaviour: core.md "git" — the only wrapper around the git command
// line: repositories, revisions and refs. Arguments that may come from content
// are validated before git sees them, and the ambient git environment of the
// calling process (for example inside a hook) never redirects an operation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGit,
  currentBranch,
  deleteRef,
  gitVersion,
  initRepository,
  isAncestor,
  meetsMinimumGitVersion,
  listRefs,
  repositoryRoot,
  resolveRevision,
  updateRef,
} from '../../../src/core/git/index.ts';
import { redactUrlCredentials } from '../../../src/core/git/exec.ts';
import { gitFor, withTempRepo } from '../../support/git-repo.ts';

test('the installed git reports its version; a missing git is reported, not thrown', async () => {
  const version = await gitVersion(createGit());
  assert.ok(version.ok && /^\d+\.\d+/.test(version.value));
  const missing = await gitVersion(createGit({ binary: 'no-such-git-binary' }));
  assert.deepEqual(missing, { ok: false, error: { reason: 'git-unavailable' } });
});

test('a repository can be initialised with a chosen initial branch and its root found from a subdirectory', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const dir = mkdtempSync(join(tmpdir(), 'pav-init-'));
  try {
    assert.deepEqual(await initRepository(git, dir, { initialBranch: 'trunk' }), { ok: true, value: undefined });
    const root = await repositoryRoot(git, dir);
    assert.ok(root.ok);
    repo.write('a/b/file.md', 'x');
    const fromSub = await repositoryRoot(git, join(repo.path, 'a', 'b'));
    assert.ok(fromSub.ok);
    assert.equal(fromSub.value, (await repositoryRoot(git, repo.path) as { value: string }).value);
    const outside = mkdtempSync(join(tmpdir(), 'pav-plain-'));
    try {
      assert.deepEqual(await repositoryRoot(git, outside), { ok: false, error: { reason: 'not-a-repository' } });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('revisions resolve to full SHAs; unknown ones are an error value naming the revision', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  assert.deepEqual(await resolveRevision(git, repo.path, 'main'), { ok: true, value: sha });
  assert.deepEqual(await resolveRevision(git, repo.path, 'HEAD'), { ok: true, value: sha });
  assert.deepEqual(await resolveRevision(git, repo.path, sha), { ok: true, value: sha });
  assert.deepEqual(await resolveRevision(git, repo.path, 'nope'), {
    ok: false,
    error: { reason: 'unknown-revision', revision: 'nope' },
  });
}));

test('revisions that could be read as options, ranges or other syntax are refused before git runs', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('first');
  for (const bad of ['', '--output=/tmp/x', '-h', 'main..HEAD', 'a b', 'main\n--all', 'HEAD;ls', '$(id)']) {
    const result = await resolveRevision(git, repo.path, bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    if (!result.ok) assert.equal(result.error.reason, 'invalid-argument', JSON.stringify(bad));
  }
}));

test('the current branch is reported, and undefined when detached', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  assert.deepEqual(await currentBranch(git, repo.path), { ok: true, value: 'main' });
  repo.git('checkout', '--quiet', '--detach', sha);
  assert.deepEqual(await currentBranch(git, repo.path), { ok: true, value: undefined });
}));

test('a ref is created only if absent, and moved only from the value the caller saw', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const first = repo.commit('first');
  repo.write('a.md', 'b');
  const second = repo.commit('second');
  assert.deepEqual(await updateRef(git, repo.path, 'refs/heads/actor/alice', first, null), { ok: true, value: undefined });
  assert.deepEqual(await updateRef(git, repo.path, 'refs/heads/actor/alice', second, null), {
    ok: false,
    error: { reason: 'ref-moved', ref: 'refs/heads/actor/alice' },
  });
  assert.deepEqual(await updateRef(git, repo.path, 'refs/heads/actor/alice', second, second), {
    ok: false,
    error: { reason: 'ref-moved', ref: 'refs/heads/actor/alice' },
  });
  assert.deepEqual(await updateRef(git, repo.path, 'refs/heads/actor/alice', second, first), { ok: true, value: undefined });
  assert.equal(repo.git('rev-parse', 'actor/alice'), second);
  assert.deepEqual(await deleteRef(git, repo.path, 'refs/heads/actor/alice', first), {
    ok: false,
    error: { reason: 'ref-moved', ref: 'refs/heads/actor/alice' },
  });
  assert.deepEqual(await deleteRef(git, repo.path, 'refs/heads/actor/alice', second), { ok: true, value: undefined });
  assert.equal(repo.git('branch', '--list', 'actor/alice'), '');
}));

test('ref updates require a full ref name and a full SHA', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  for (const [ref, value] of [['main', sha], ['--delete', sha], ['refs/heads/x', 'main'], ['refs/heads/x', sha.slice(0, 8)]] as const) {
    const result = await updateRef(git, repo.path, ref, value, null);
    assert.equal(result.ok === false && result.error.reason, 'invalid-argument', `${ref} ${value}`);
  }
}));

test('refs under a prefix are listed with their SHAs', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const first = repo.commit('first');
  repo.git('branch', 'actor/alice');
  repo.write('a.md', 'b');
  const second = repo.commit('second');
  repo.git('branch', 'actor/bob');
  repo.git('branch', 'other');
  assert.deepEqual(await listRefs(git, repo.path, 'refs/heads/actor/'), {
    ok: true,
    value: [
      { ref: 'refs/heads/actor/alice', sha: first },
      { ref: 'refs/heads/actor/bob', sha: second },
    ],
  });
  assert.deepEqual(await listRefs(git, repo.path, 'refs/heads/none/'), { ok: true, value: [] });
}));

test('ancestry distinguishes a descendant from a rewrite', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  const first = repo.commit('first');
  repo.write('a.md', 'b');
  const second = repo.commit('second');
  assert.deepEqual(await isAncestor(git, repo.path, first, second), { ok: true, value: true });
  assert.deepEqual(await isAncestor(git, repo.path, second, first), { ok: true, value: false });
  assert.deepEqual(await isAncestor(git, repo.path, first, first), { ok: true, value: true });
  const unknown = await isAncestor(git, repo.path, '0'.repeat(40), second);
  assert.equal(unknown.ok === false && unknown.error.reason, 'unknown-revision');
}));

test('the ambient git environment of the caller cannot redirect an operation', withTempRepo(async (repo) => {
  repo.write('a.md', 'a');
  const sha = repo.commit('first');
  const decoy = mkdtempSync(join(tmpdir(), 'pav-decoy-'));
  try {
    // As when the daemon is started from a hook: GIT_DIR and friends point elsewhere.
    const git = createGit({ env: { ...repo.env, GIT_DIR: join(decoy, 'nope'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: join(decoy, 'index') } });
    assert.deepEqual(await resolveRevision(git, repo.path, 'main'), { ok: true, value: sha });
    assert.equal(existsSync(join(decoy, 'index')), false);
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
}));

test('credentials embedded in a URL are redacted from anything git reports', () => {
  const text = 'fatal: unable to access https://user:hunter2@example.net/x.git/ and ssh://bot:tok3n@host:22/y';
  const redacted = redactUrlCredentials(text);
  assert.ok(!redacted.includes('hunter2') && !redacted.includes('tok3n'));
  assert.match(redacted, /https:\/\/example\.net\/x\.git/);
});

test('the minimum supported git version is enforced by comparison, not string order', () => {
  assert.equal(meetsMinimumGitVersion('2.36.0'), true);
  assert.equal(meetsMinimumGitVersion('2.55.0'), true);
  assert.equal(meetsMinimumGitVersion('3.0.1'), true);
  assert.equal(meetsMinimumGitVersion('2.9.5'), false);
  assert.equal(meetsMinimumGitVersion('1.99.0'), false);
});
