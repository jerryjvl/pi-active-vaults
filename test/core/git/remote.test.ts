// Documented behaviour: core.md "git", security.md — fetching and pushing go
// through the git module like everything else. Remotes are named, or given as
// an https, ssh or local URL: transports that run commands (`ext::`) or carry
// no integrity (`http://`, `git://`) are refused before git runs, and the
// remote's objects are checked as they arrive. Refspecs name full refs. Tests
// use local repositories as remotes; there is no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRemote, fetchCommit, fetchRefs, pushRefs, remoteUrl, resolveRevision } from '../../../src/core/git/index.ts';
import { createTempRepo, gitFor, withTempRepo } from '../../support/git-repo.ts';

test('a commit is fetched shallowly from a URL, by ref or the remote\'s HEAD, and named by its SHA', withTempRepo(async (repo) => {
  const source = createTempRepo();
  try {
    source.write('a.md', 'one');
    source.commit('one');
    source.git('tag', 'v1');
    source.write('a.md', 'two');
    const tip = source.commit('two');
    const tagged = source.git('rev-parse', 'v1^{commit}');
    assert.deepEqual(await fetchCommit(gitFor(repo), repo.path, source.path), { ok: true, value: tip });
    assert.deepEqual(await fetchCommit(gitFor(repo), repo.path, source.path, 'v1'), { ok: true, value: tagged });
    assert.equal(repo.git('rev-list', '--count', tagged), '1', 'only the commit asked for, no history');
    const missing = await fetchCommit(gitFor(repo), repo.path, source.path, 'no-such-ref');
    assert.equal(!missing.ok && missing.error.reason, 'git-failed');
  } finally {
    source.cleanup();
  }
}));

test('refs are fetched and pushed by explicit refspecs', withTempRepo(async (repo) => {
  const remote = createTempRepo();
  try {
    repo.write('a.md', 'a');
    const sha = repo.commit('a');
    repo.git('branch', 'actor/gardener');
    assert.ok((await pushRefs(gitFor(repo), repo.path, remote.path, ['refs/heads/actor/gardener:refs/heads/actor/gardener'])).ok);
    assert.equal(remote.git('rev-parse', 'refs/heads/actor/gardener'), sha);
    assert.ok((await fetchRefs(gitFor(repo), repo.path, remote.path, ['+refs/heads/actor/gardener:refs/remotes/origin/actor/gardener'])).ok);
    assert.deepEqual(await resolveRevision(gitFor(repo), repo.path, 'refs/remotes/origin/actor/gardener'), { ok: true, value: sha });
  } finally {
    remote.cleanup();
  }
}));

test('a named remote\'s URL can be read; an unknown remote has none', withTempRepo(async (repo) => {
  repo.git('remote', 'add', 'origin', 'https://git.example.net/home/vault.git');
  assert.deepEqual(await remoteUrl(gitFor(repo), repo.path, 'origin'), { ok: true, value: 'https://git.example.net/home/vault.git' });
  assert.deepEqual(await remoteUrl(gitFor(repo), repo.path, 'upstream'), { ok: true, value: undefined });
}));

test('transports that run commands or lack integrity, option-like values and loose refspecs are refused before git runs', withTempRepo(async (repo) => {
  repo.commit('c');
  for (const remote of ['ext::sh -c touch% /tmp/pwned', 'http://git.example.net/x.git', 'git://git.example.net/x.git', '--upload-pack=touch /tmp/pwned', 'fd::17', 'https://exa mple.net/x.git', '']) {
    const fetched = await fetchCommit(gitFor(repo), repo.path, remote);
    assert.deepEqual(!fetched.ok && fetched.error, { reason: 'invalid-argument', argument: 'remote' }, remote);
  }
  for (const refspec of ['main', 'refs/heads/main:main', '--force', 'refs/heads/a:refs/heads/../b', 'HEAD:refs/heads/x']) {
    const pushed = await pushRefs(gitFor(repo), repo.path, repo.path, [refspec]);
    assert.deepEqual(!pushed.ok && pushed.error, { reason: 'invalid-argument', argument: 'refspec' }, refspec);
  }
  for (const accepted of ['https://git.example.net/x.git', 'ssh://git@git.example.net/x.git', 'git@git.example.net:home/x.git', 'origin', '/srv/git/x.git', 'file:///srv/git/x.git', 'C:\\vaults\\x']) {
    assert.ok(checkRemote(accepted).ok, accepted);
  }
  const local = await fetchCommit(gitFor(repo), repo.path, '/nonexistent/vault.git');
  assert.equal(!local.ok && local.error.reason, 'git-failed', 'a local path is allowed through to git');
}));
