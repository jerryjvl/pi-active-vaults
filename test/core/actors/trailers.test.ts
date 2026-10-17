// Documented behaviour: concepts.md "Actor" and "Merge policy" — package
// commits carry Vault-Trace, Vault-Actor, Vault-Session (from a Pi session) and
// Vault-Tainted (from a tainted session); a commit is tainted when it carries
// Vault-Tainted or was not made by the package. Taint fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTaintedCommit, packageTrailers, trailerValue } from '../../../src/core/actors/index.ts';

test('package trailers name the trace and actor, and the session and taint when there are any', () => {
  assert.deepEqual(packageTrailers({ trace: 'T1', actor: 'gardener' }), [
    { key: 'Vault-Trace', value: 'T1' },
    { key: 'Vault-Actor', value: 'gardener' },
  ]);
  assert.deepEqual(packageTrailers({ trace: 'T1', actor: 'gardener', session: 'S1', tainted: true }), [
    { key: 'Vault-Trace', value: 'T1' },
    { key: 'Vault-Actor', value: 'gardener' },
    { key: 'Vault-Session', value: 'S1' },
    { key: 'Vault-Tainted', value: 'yes' },
  ]);
});

test('a commit is tainted when marked, or when the package did not make it', () => {
  const commit = (...trailers: [string, string][]) => ({ trailers: trailers.map(([key, value]) => ({ key, value })) });
  assert.equal(isTaintedCommit(commit(['Vault-Trace', 'T1'], ['Vault-Actor', 'gardener'])), false);
  assert.equal(isTaintedCommit(commit(['Vault-Trace', 'T1'], ['Vault-Tainted', 'yes'])), true);
  assert.equal(isTaintedCommit(commit(['Vault-Trace', 'T1'], ['Vault-Tainted', 'no'])), true, 'any value marks it');
  assert.equal(isTaintedCommit(commit()), true, 'made outside the package');
  assert.equal(isTaintedCommit(commit(['vault-trace', 'T1'])), false, 'trailer keys are case-insensitive, as in Git');
});

test('a trailer\'s value is its last occurrence', () => {
  const commit = { trailers: [{ key: 'Vault-Trace', value: 'T1' }, { key: 'Vault-Trace', value: 'T2' }] };
  assert.equal(trailerValue(commit, 'Vault-Trace'), 'T2');
  assert.equal(trailerValue(commit, 'Vault-Session'), undefined);
});
