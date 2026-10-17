// Documented behaviour: cli.md `vault doctor` — it reports a `core.hooksPath`
// that bypasses the package's hooks, a `local` vault with a remote, and a
// leftover Git lock in main's worktree; these read a repository's config,
// its remotes and where each worktree's Git directory is, through the git
// module like everything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { configValue, gitDirectories, listRemotes } from '../../../src/core/git/index.ts';
import { gitFor, withTempRepo } from '../../support/git-repo.ts';

test('a config value is read as the repository sees it; an unset one is undefined', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  assert.deepEqual(await configValue(git, repo.path, 'core.hooksPath'), { ok: true, value: undefined });
  repo.git('config', 'core.hooksPath', '/elsewhere/hooks');
  assert.deepEqual(await configValue(git, repo.path, 'core.hooksPath'), { ok: true, value: '/elsewhere/hooks' });
  assert.equal((await configValue(git, repo.path, '--global')).ok, false, 'a key is never read as an option');
}));

test('remotes are listed by name', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  assert.deepEqual(await listRemotes(git, repo.path), { ok: true, value: [] });
  repo.git('remote', 'add', 'origin', 'https://git.example.net/home/vault.git');
  repo.git('remote', 'add', 'backup', '/srv/backup.git');
  assert.deepEqual(await listRemotes(git, repo.path), { ok: true, value: ['backup', 'origin'] });
}));

test('a worktree\'s own Git directory and the repository\'s common one are found', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('a.md', 'a');
  repo.commit('base');
  const main = await gitDirectories(git, repo.path);
  const own = realpathSync(join(repo.path, '.git'));
  assert.deepEqual(main.ok && { own: realpathSync(main.value.own), common: realpathSync(main.value.common) }, { own, common: own });
  const linked = join(repo.path, '..', `pav-linked-${process.pid}`);
  repo.git('worktree', 'add', '--quiet', '-b', 'other', linked);
  try {
    const dirs = await gitDirectories(git, linked);
    assert.ok(dirs.ok);
    assert.equal(realpathSync(dirs.value.common), own);
    assert.equal(realpathSync(dirs.value.own), realpathSync(join(own, 'worktrees', `pav-linked-${process.pid}`)));
  } finally {
    repo.git('worktree', 'remove', '--force', linked);
  }
}));
