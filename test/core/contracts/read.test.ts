// Documented behaviour: concepts.md "Contracts" and security.md — a
// `_contract.md` governs its directory and everything below it, and contracts
// are read from a given commit (the accepted `main`), never from the working
// tree or a branch. A governing contract that cannot be read is an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveContract } from '../../../src/core/contracts/index.ts';
import { gitFor, withTempRepo } from '../../support/git-repo.ts';

const contract = (yaml: string, body = ''): string => `---\n${yaml}\n---\n${body}`;

test('a file is governed by the contracts of every directory above it, read at the revision', withTempRepo(async (repo) => {
  repo.write('_contract.md', contract('naming: "{topic}.md"', 'Root prose.\n'));
  repo.write('topics/_contract.md', contract('index: opt-in'));
  repo.write('topics/cars/_contract.md', contract('naming: "{car}.md"'));
  repo.write('other/_contract.md', contract('index: none'));
  const sha = repo.commit('contracts');
  repo.write('topics/_contract.md', contract('index: none')); // uncommitted: not part of the revision

  const c = await effectiveContract(gitFor(repo), repo.path, sha, 'topics/cars/a.md');
  assert.ok(c.ok);
  assert.deepEqual(c.value.values, { naming: '{car}.md', index: 'opt-in' });
  assert.deepEqual(c.value.contracts, ['_contract.md', 'topics/_contract.md', 'topics/cars/_contract.md']);
  assert.deepEqual(c.value.prose, [{ path: '_contract.md', body: 'Root prose.\n' }]);
}));

test('a directory is governed by its own contract too; a file is not governed by a directory beside it', withTempRepo(async (repo) => {
  repo.write('_contract.md', contract('index: default'));
  repo.write('topics/_contract.md', contract('index: opt-in'));
  const sha = repo.commit('contracts');
  const git = gitFor(repo);
  const directory = await effectiveContract(git, repo.path, sha, 'topics');
  const beside = await effectiveContract(git, repo.path, sha, 'topics.md');
  const vaultRoot = await effectiveContract(git, repo.path, sha, '');
  assert.ok(directory.ok && beside.ok && vaultRoot.ok);
  assert.equal(directory.value.values['index'], 'opt-in');
  assert.equal(beside.value.values['index'], 'default');
  assert.deepEqual(vaultRoot.value.contracts, ['_contract.md']);
}));

test('a path that does not exist yet is governed as a new file would be', withTempRepo(async (repo) => {
  repo.write('topics/_contract.md', contract('index: opt-in'));
  const sha = repo.commit('contracts');
  const c = await effectiveContract(gitFor(repo), repo.path, sha, 'topics/new/idea.md');
  assert.ok(c.ok);
  assert.deepEqual(c.value.contracts, ['topics/_contract.md']);
}));

test('a contract on another branch has no effect on the revision read', withTempRepo(async (repo) => {
  repo.write('_contract.md', contract('index: default'));
  const sha = repo.commit('root');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('_contract.md', contract('index: none'));
  repo.commit('proposal');
  const c = await effectiveContract(gitFor(repo), repo.path, sha, 'a.md');
  assert.ok(c.ok);
  assert.equal(c.value.values['index'], 'default');
}));

test('an unreadable governing contract fails the whole contract and names the file; others do not matter', withTempRepo(async (repo) => {
  repo.write('_contract.md', contract('index: default'));
  repo.write('topics/_contract.md', contract('index: [unclosed'));
  repo.write('notes/_contract.md', 'no frontmatter at all is fine');
  const sha = repo.commit('contracts');
  const git = gitFor(repo);
  const broken = await effectiveContract(git, repo.path, sha, 'topics/a.md');
  assert.equal(broken.ok, false);
  if (!broken.ok) {
    assert.equal(broken.error.reason, 'invalid-contract');
    if (broken.error.reason === 'invalid-contract') assert.match(broken.error.issues[0]?.path ?? '', /^topics\/_contract\.md/);
  }
  assert.ok((await effectiveContract(git, repo.path, sha, 'notes/a.md')).ok);
}));

test('an unknown revision is an error, not an empty contract', withTempRepo(async (repo) => {
  repo.commit('empty');
  const c = await effectiveContract(gitFor(repo), repo.path, 'no-such-branch', 'a.md');
  assert.equal(c.ok === false && c.error.reason, 'unknown-revision');
}));
