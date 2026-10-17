// Documented behaviour: concepts.md "Attestation and merge policy" — an
// attestation records a verdict (kind, name, subject, result, by, version,
// evidence, at) about an exact subject, stored as one JSON object per line in
// the subject's note on refs/notes/vault/attestations; for each kind and name
// the latest record counts. Records that cannot be read fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTESTATIONS_REF,
  latestAttestation,
  readAttestations,
  recordAttestation,
  type Attestation,
} from '../../../src/core/attestations/index.ts';
import { gitFor, withTempRepo, type TempRepo } from '../../support/git-repo.ts';

const BOT = { identity: { name: 'Vault', email: 'vault@example.net' } };

function check(subject: string, result: string, overrides: Partial<Attestation> = {}): Attestation {
  return { kind: 'check', name: 'links', subject, result, by: 'links', version: 'b'.repeat(40), at: '2026-01-01T00:00:00.000Z', ...overrides };
}

async function record(repo: TempRepo, attestation: Attestation): Promise<void> {
  const recorded = await recordAttestation(gitFor(repo), repo.path, attestation, BOT);
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
    { kind: 'judgement', name: 'links', subject: sha, result: 'pass', by: 'model', version: 'v', at: 'x' } as Attestation,
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
  const judgement: Attestation = { kind: 'judgement', name: 'quality', subject: blob, result: 'pass', by: 'judge-model', version: 'axes-1', at: 'now' };
  await record(repo, judgement);
  assert.deepEqual(await readAttestations(gitFor(repo), repo.path, blob), { ok: true, value: [judgement] });
}));

test('a note that cannot be read as attestations fails closed, naming the subject and lines', withTempRepo(async (repo) => {
  const sha = repo.commit('c');
  const other = repo.commit('d');
  await record(repo, check(sha, 'pass'));
  repo.git('notes', `--ref=${ATTESTATIONS_REF}`, 'append', '-m', 'not json', sha);
  repo.git('notes', `--ref=${ATTESTATIONS_REF}`, 'append', '-m', JSON.stringify(check(other, 'pass')), sha);
  const read = await readAttestations(gitFor(repo), repo.path, sha);
  assert.deepEqual(read, { ok: false, error: { reason: 'invalid-attestations', subject: sha, lines: [2, 3] } });
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
  ]) {
    const recorded = await recordAttestation(gitFor(repo), repo.path, bad, BOT);
    assert.equal(!recorded.ok && recorded.error.reason, 'invalid-attestation', JSON.stringify(bad));
  }
  assert.equal(repo.git('for-each-ref', ATTESTATIONS_REF), '');
}));
