// Documented behaviour: concepts.md "Trace" — each commit a run makes carries
// its compact record as of that commit, as a note on refs/notes/vault/traces
// rather than a file in the tree; the `Vault-Trace` trailer is the link, so a
// run's records are found by finding its commits by trailer and reading their
// notes. The notes travel with the repository like attestations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTempRepo, gitFor, TEST_ATTRIBUTION, withTempRepo, type TempRepo } from '../../support/git-repo.ts';
import { TRACES_REF, recordRun, runCommits, type RunRecord } from '../../../src/core/traces/index.ts';

const TRACE = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const OTHER = '01JABCDEFGHJKMNPQRSTVWXYZ1';

function record(trace = TRACE): RunRecord {
  return {
    trace, vault: 'home', path: [], trigger: { event: 'manual', document: 'jobs/daily.md' },
    sessions: [{ actor: 'gardener', started: '2026-01-01T00:00:00.000Z', tokens: 10, outcome: 'committed' }],
    judgements: [], scripts: [], elsewhere: [],
  };
}

const commitOf = (repo: TempRepo, trace: string, files: Record<string, string | null>, message = 'Work'): string => {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) repo.git('rm', '--quiet', path);
    else repo.write(path, content);
  }
  return repo.commit(`${message}\n\nVault-Trace: ${trace}\nVault-Actor: gardener`);
};

test('each of a run\'s commits carries its record as of that commit, in a note, naming what the run has produced so far', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const since = repo.commit('accepted');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  const first = commitOf(repo, TRACE, { 'notes/a.md': 'A', 'notes/gone.md': 'G', 'data.csv': 'x' });
  const recorded = await recordRun(git, repo.path, { since, commit: first, record: record(), attribution: TEST_ATTRIBUTION });
  assert.ok(recorded.ok, JSON.stringify(recorded));
  assert.deepEqual(recorded.value.documents, ['notes/a.md', 'notes/gone.md']);

  commitOf(repo, OTHER, { 'notes/theirs.md': 'another run' });
  const second = commitOf(repo, TRACE, { 'notes/b.md': 'B', 'notes/gone.md': null });
  const again = await recordRun(git, repo.path, { since, commit: second, record: record(), attribution: TEST_ATTRIBUTION });
  assert.ok(again.ok);
  assert.deepEqual(again.value.documents, ['notes/a.md', 'notes/b.md'], 'a deleted document is no longer named; another run\'s is never');

  assert.deepEqual(repo.git('ls-tree', '-r', '--name-only', second).split('\n').filter((p) => p.startsWith('.vault/')), [], 'nothing in the tree');
  const commits = await runCommits(git, repo.path, ['actor/gardener'], TRACE);
  assert.ok(commits.ok);
  assert.deepEqual(commits.value.map((c) => [c.commit, 'records' in c ? c.records.map((r) => r.documents) : c.unreadable]), [
    [second, [['notes/a.md', 'notes/b.md']]],
    [first, [['notes/a.md', 'notes/gone.md']]],
  ], 'newest first, each with the record it was made with');
  assert.match(repo.git('notes', `--ref=${TRACES_REF}`, 'show', first), /^\{"trace":"01JABCDEFGHJKMNPQRSTVWXYZ0",/);
}));

test('a record that is not well formed, or not of the commit\'s run, is refused before anything is written', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const since = repo.commit('accepted');
  const commit = commitOf(repo, TRACE, { 'notes/a.md': 'A' });
  const invalid = await recordRun(git, repo.path, { since, commit, record: { ...record(), vault: '' }, attribution: TEST_ATTRIBUTION });
  assert.equal(!invalid.ok && invalid.error.reason, 'invalid-trace');
  const misplaced = await recordRun(git, repo.path, { since, commit, record: record(OTHER), attribution: TEST_ATTRIBUTION });
  assert.equal(!misplaced.ok && misplaced.error.reason, 'not-the-run');
  assert.equal(repo.git('notes', `--ref=${TRACES_REF}`, 'list'), '');
}));

test('a note that cannot be read in full, or records another run, is reported unreadable, never read in part', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const since = repo.commit('accepted');
  const commit = commitOf(repo, TRACE, { 'notes/a.md': 'A' });
  assert.ok((await recordRun(git, repo.path, { since, commit, record: record(), attribution: TEST_ATTRIBUTION })).ok);
  repo.git('notes', `--ref=${TRACES_REF}`, 'append', '-m', '{ not json', commit);
  const bare = commitOf(repo, TRACE, { 'notes/b.md': 'B' });
  const another = commitOf(repo, TRACE, { 'notes/c.md': 'C' });
  repo.git('notes', `--ref=${TRACES_REF}`, 'add', '-m', JSON.stringify({ ...record(OTHER), documents: [] }), another);
  const commits = await runCommits(git, repo.path, ['main'], TRACE);
  assert.ok(commits.ok);
  assert.deepEqual(commits.value, [
    { commit: another, unreadable: [1] },
    { commit: bare, records: [] },
    { commit, unreadable: [2] },
  ]);
}));

test('the notes travel: fetched into another clone with the branch, the run\'s records read back there', withTempRepo(async (repo) => {
  const git = gitFor(repo);
  const since = repo.commit('accepted');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  const commit = commitOf(repo, TRACE, { 'notes/a.md': 'A' });
  assert.ok((await recordRun(git, repo.path, { since, commit, record: record(), attribution: TEST_ATTRIBUTION })).ok);
  const clone = createTempRepo();
  try {
    clone.git('fetch', '--quiet', repo.path, 'actor/gardener:refs/heads/actor/gardener', `${TRACES_REF}:${TRACES_REF}`);
    const commits = await runCommits(gitFor(clone), clone.path, ['actor/gardener'], TRACE);
    assert.ok(commits.ok);
    assert.deepEqual(commits.value.map((c) => 'records' in c && c.records.map((r) => r.documents)), [[['notes/a.md']]]);
  } finally {
    clone.cleanup();
  }
}));
