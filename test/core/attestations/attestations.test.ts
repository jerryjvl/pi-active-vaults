// Documented behaviour: concepts.md "Attestation and merge policy" — an
// attestation records a verdict (kind, name, subject, result, by, version,
// evidence, at) about an exact subject, stored as one JSON object per line in
// the subject's note on refs/notes/vault/attestations; for each kind and name
// the latest record counts. Notes from different machines merge line by line
// (cat_sort_uniq), keeping every record. Records that cannot be read fail
// closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTESTATIONS_REF,
  latestAttestation,
  mergeAttestations,
  readAttestations,
  recordAttestation,
  type Attestation,
} from '../../../src/core/attestations/index.ts';
import { TEST_ATTRIBUTION, createTempRepo, gitFor, withTempRepo, type TempRepo } from '../../support/git-repo.ts';

function check(subject: string, result: string, overrides: Partial<Attestation> = {}): Attestation {
  return { kind: 'check', name: 'links', subject, result, by: 'links', version: 'b'.repeat(40), at: '2026-01-01T00:00:00.000Z', ...overrides };
}

async function record(repo: TempRepo, attestation: Attestation): Promise<void> {
  const recorded = await recordAttestation(gitFor(repo), repo.path, attestation, TEST_ATTRIBUTION);
  if (!recorded.ok) assert.fail(JSON.stringify(recorded.error));
}

test('attestations are read back for their exact subject, in the order recorded', withTempRepo(async (repo) => {
  const first = repo.commit('first');
  const second = repo.commit('second');
  const a = check(first, 'fail', { evidence: '2 broken links' });
  const b = check(first, 'pass', { at: '2026-01-01T00:01:00.000Z' });
  const approval: Attestation = { kind: 'approval', name: 'alice', subject: first, result: 'pass', by: 'alice', at: '2026-01-01T00:02:00.000Z' };
  await record(repo, a);
  await record(repo, b);
  await record(repo, approval);
  assert.deepEqual(await readAttestations(gitFor(repo), repo.path, first), { ok: true, value: [a, b, approval] });
  assert.deepEqual(await readAttestations(gitFor(repo), repo.path, second), { ok: true, value: [] });
}));

test('for each kind and name the latest record counts', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  const list = [
    check(sha, 'pass'),
    check(sha, 'fail', { name: 'spelling' }),
    check(sha, 'fail'),
    { kind: 'judgement', name: 'links', subject: sha, result: 'pass', by: 'model', version: 'v', at: '2026-01-01T00:00:00.000Z' } as Attestation,
  ];
  assert.equal(latestAttestation(list, 'check', 'links')?.result, 'fail');
  assert.equal(latestAttestation(list, 'check', 'spelling')?.result, 'fail');
  assert.equal(latestAttestation(list, 'judgement', 'links')?.result, 'pass');
  assert.equal(latestAttestation(list, 'approval', 'alice'), undefined);
}));

test('they are stored as JSON lines in the subject\'s note, so they travel with the repository', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  await record(repo, check(sha, 'pass'));
  await record(repo, check(sha, 'fail'));
  const lines = repo.git('notes', `--ref=${ATTESTATIONS_REF}`, 'show', sha).split('\n').filter((l) => l !== '');
  assert.deepEqual(lines.map((l) => JSON.parse(l).result), ['pass', 'fail']);
  assert.equal(ATTESTATIONS_REF, 'refs/notes/vault/attestations');
  assert.match(repo.git('log', '-1', '--format=%an', ATTESTATIONS_REF), /^Vault$/);
}));

test('content can be attested by its blob SHA', withTempRepo(async (repo) => {
  repo.write('topics/a.md', 'content');
  const commit = repo.commit('c');
  const blob = repo.git('rev-parse', `${commit}:topics/a.md`);
  const judgement: Attestation = { kind: 'judgement', name: 'quality', subject: blob, result: 'pass', by: 'judge-model', version: 'axes-1', at: '2026-01-01T00:00:00.000Z' };
  await record(repo, judgement);
  assert.deepEqual(await readAttestations(gitFor(repo), repo.path, blob), { ok: true, value: [judgement] });
}));

test('a note that cannot be read as attestations fails closed, naming the subject and the unreadable records', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  const other = repo.commit('d');
  await record(repo, check(sha, 'pass'));
  repo.git('notes', `--ref=${ATTESTATIONS_REF}`, 'append', '-m', 'not json', sha);
  repo.git('notes', `--ref=${ATTESTATIONS_REF}`, 'append', '-m', JSON.stringify(check(other, 'pass')), sha);
  const read = await readAttestations(gitFor(repo), repo.path, sha);
  assert.deepEqual(read, { ok: false, error: { reason: 'invalid-attestations', subject: sha, records: [2, 3] } });
}));

test('an attestation that is not well formed is refused before anything is written', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  for (const bad of [
    check(sha, 'pass', { kind: 'vibe' as Attestation['kind'] }),
    check(sha, ''),
    check(sha, 'pass', { name: '' }),
    check(sha, 'pass', { by: '' }),
    check('HEAD', 'pass'),
    check(sha, 'pass', { name: 'two\nlines' }),
    check(sha, 'pass', { at: 'yesterday' }),
    check(sha, 'pass', { at: '2026-01-01T00:00:00+02:00' }),
  ]) {
    const recorded = await recordAttestation(gitFor(repo), repo.path, bad, TEST_ATTRIBUTION);
    assert.equal(!recorded.ok && recorded.error.reason, 'invalid-attestation', JSON.stringify(bad));
  }
  assert.equal(repo.git('for-each-ref', ATTESTATIONS_REF), '');
}));

test('the latest record is the one recorded last in time, whatever its place in the note; at the same time a non-pass wins', () => {
  const sha = 'a'.repeat(40);
  const late = check(sha, 'pass', { at: '2026-01-02T00:00:00.000Z' });
  const early = check(sha, 'fail', { at: '2026-01-01T00:00:00.000Z' });
  assert.equal(latestAttestation([late, early], 'check', 'links'), late);
  const tiedPass = check(sha, 'pass', { at: '2026-01-03T00:00:00.000Z' });
  const tiedFail = check(sha, 'fail', { at: '2026-01-03T00:00:00.000Z', by: 'other' });
  assert.equal(latestAttestation([tiedFail, tiedPass], 'check', 'links'), tiedFail, 'fail closed when two records are equally late');
  assert.equal(latestAttestation([tiedPass, tiedFail], 'check', 'links'), tiedFail);
});

test('notes from two clones merge line by line: every record from both sides is kept, duplicates once', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  const clone = createTempRepo();
  try {
    clone.git('fetch', '--quiet', repo.path, 'main:refs/remotes/origin/main');
    const ours = check(sha, 'fail', { at: '2026-01-01T00:00:00.000Z' });
    const shared = check(sha, 'pass', { name: 'spelling', at: '2026-01-01T00:00:00.000Z' });
    const theirs = check(sha, 'pass', { at: '2026-01-02T00:00:00.000Z' });
    await record(repo, ours);
    await record(repo, shared);
    await record(clone, shared);
    await record(clone, theirs);
    clone.git('push', '--quiet', repo.path, `${ATTESTATIONS_REF}:refs/notes/vault/incoming`);

    const merged = await mergeAttestations(gitFor(repo), repo.path, 'refs/notes/vault/incoming', TEST_ATTRIBUTION);
    assert.deepEqual(merged, { ok: true, value: undefined });
    const read = await readAttestations(gitFor(repo), repo.path, sha);
    assert.ok(read.ok);
    assert.deepEqual(new Set(read.value), new Set([ours, shared, theirs]));
    assert.equal(read.value.length, 3);
    assert.equal(latestAttestation(read.value, 'check', 'links'), read.value.find((a) => a.at === theirs.at));
  } finally {
    clone.cleanup();
  }
}));

test('merging into a repository with no attestations yet takes the other side\'s, and a bad ref is refused', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  const clone = createTempRepo();
  try {
    clone.git('fetch', '--quiet', repo.path, 'main:refs/remotes/origin/main');
    await record(clone, check(sha, 'pass'));
    clone.git('push', '--quiet', repo.path, `${ATTESTATIONS_REF}:refs/notes/vault/incoming`);
    assert.ok((await mergeAttestations(gitFor(repo), repo.path, 'refs/notes/vault/incoming', TEST_ATTRIBUTION)).ok);
    assert.deepEqual(await readAttestations(gitFor(repo), repo.path, sha), { ok: true, value: [check(sha, 'pass')] });
    const refused = await mergeAttestations(gitFor(repo), repo.path, '--strategy=ours', TEST_ATTRIBUTION);
    assert.equal(!refused.ok && refused.error.reason, 'invalid-argument');
  } finally {
    clone.cleanup();
  }
}));
