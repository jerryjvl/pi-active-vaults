// Documented behaviour: concepts.md "Contracts" — the root contract identifies
// the vault: `id`, `purpose`, `audience`, `owners`, `actors`; optionally
// `executor`, `review` (local by default) and `from-template`. An actor is one
// of `actors` or `owners`. The identity is read from a commit and validated
// strictly: a misspelt key must not silently drop the owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActor, isOwner, parseVaultIdentity, readVaultIdentity, type VaultIdentity } from '../../../src/core/registry/index.ts';
import { gitFor, withTempRepo } from '../../support/git-repo.ts';

const EXAMPLE = {
  id: 'home-knowledge',
  purpose: {
    summary: 'House hardware, network and how things connect.',
    'use-for': ['device questions', 'network topology'],
    'not-for': ['personal health', 'work'],
  },
  audience: 'household',
  owners: ['alice', 'bob'],
  actors: ['librarian', 'gardener'],
  executor: 'alice@homeserver',
};

function identity(value: unknown): VaultIdentity {
  const parsed = parseVaultIdentity(value);
  if (!parsed.ok) assert.fail(JSON.stringify(parsed.error));
  return parsed.value;
}

const issues = (value: unknown): string[] => {
  const parsed = parseVaultIdentity(value);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
};

test('the documented root contract gives the vault identity, reviewed locally by default', () => {
  assert.deepEqual(identity(EXAMPLE), {
    id: 'home-knowledge',
    purpose: {
      summary: 'House hardware, network and how things connect.',
      useFor: ['device questions', 'network topology'],
      notFor: ['personal health', 'work'],
    },
    audience: 'household',
    owners: ['alice', 'bob'],
    actors: ['librarian', 'gardener'],
    executor: 'alice@homeserver',
    review: 'local',
  });
  assert.equal(identity({ ...EXAMPLE, review: 'forge' }).review, 'forge');
  const fromTemplate = { source: 'https://git.example.net/templates/research.git', commit: 'a'.repeat(40) };
  assert.deepEqual(identity({ ...EXAMPLE, 'from-template': fromTemplate }).fromTemplate, fromTemplate);
});

test('a vault needs an id, a purpose summary, an audience and at least one owner; every problem is reported', () => {
  assert.deepEqual(issues({ purpose: {}, owners: [], actors: 'gardener' }), [
    'vault.id: must be a non-empty string',
    'vault.purpose.summary: must be a non-empty string',
    'vault.audience: must be a non-empty string',
    'vault.owners: must name at least one owner',
    'vault.actors: must be a list',
  ]);
});

test('unknown keys, repeated or malformed names and an unknown review mode are errors', () => {
  assert.deepEqual(issues({ ...EXAMPLE, owner: ['mallory'], owners: ['alice', 'alice'], actors: ['../x'], review: 'email' }), [
    'vault.owner: unknown key',
    'vault.owners[1]: repeats an earlier name',
    'vault.actors[0]: is not in the expected form',
    'vault.review: must be one of local, forge',
  ]);
});

test('owners are actors too; anyone else is neither', () => {
  const vault = identity(EXAMPLE);
  assert.ok(isOwner(vault, 'alice'));
  assert.ok(!isOwner(vault, 'gardener'));
  assert.ok(isActor(vault, 'gardener'));
  assert.ok(isActor(vault, 'bob'));
  assert.ok(!isActor(vault, 'mallory'));
});

test('the identity is read from the root contract at a revision', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('_contract.md', '---\nvault:\n  id: home\n  purpose: { summary: Home }\n  audience: household\n  owners: [alice]\n  actors: []\n---\n');
  const sha = repo.commit('root');
  repo.write('_contract.md', '---\nvault:\n  id: changed\n---\n'); // uncommitted
  const read = await readVaultIdentity(git, repo.path, sha);
  assert.ok(read.ok);
  assert.equal(read.value.id, 'home');
}));

test('a repository without a root contract, or one without a vault key, has no identity', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  repo.write('notes/a.md', 'a');
  const bare = repo.commit('no contract');
  assert.equal((await readVaultIdentity(git, repo.path, bare)).ok === false, true);
  const none = await readVaultIdentity(git, repo.path, bare);
  assert.equal(!none.ok && none.error.reason, 'no-identity');
  repo.write('_contract.md', '---\nindex: default\n---\n');
  const keyless = await readVaultIdentity(git, repo.path, repo.commit('contract without identity'));
  assert.equal(!keyless.ok && keyless.error.reason, 'no-identity');
  repo.write('_contract.md', '---\nvault: { id: x }\n---\n');
  const invalid = await readVaultIdentity(git, repo.path, repo.commit('incomplete identity'));
  assert.equal(!invalid.ok && invalid.error.reason, 'invalid-identity');
}));
