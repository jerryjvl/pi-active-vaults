// Documented behaviour: signer.md "Statements" — a statement is a compact JWS
// signed with Ed25519, whose header names exactly `alg: EdDSA`, the key's ID
// and its type; a verifier accepts only the one type it asks for, only from a
// key it trusts, only intact and only until it expires; a statement longer
// than its limit is not made. A web grant is a statement of type
// `vault-grant`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GRANT_TYPE, signGrant, verifyGrant, type GrantClaims } from '../../../src/core/grants/index.ts';
import { newSigningKey, signStatement, signingKeyFrom, verifyStatement } from '../../../src/core/signing/index.ts';

const NOW = new Date('2026-10-31T00:00:00Z');
const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);

function key() {
  const made = newSigningKey();
  const parsed = signingKeyFrom(made.pem);
  if (!parsed.ok) assert.fail(parsed.error.reason);
  return { ...parsed.value, made };
}

const claims = (exp = seconds(NOW) + 600): Record<string, unknown> => ({ iss: 'alice@homeserver', exp, about: 'something' });

test('a statement verifies with its key and type, and its header says exactly algorithm, key and type', () => {
  const k = key();
  assert.deepEqual(k.made.jwk, k.jwk, 'the printed public key is the one the private key has');
  const signed = signStatement('example', claims(), k);
  if (!signed.ok) assert.fail('not signed');
  const header = JSON.parse(Buffer.from(signed.value.split('.')[0] ?? '', 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'EdDSA', kid: k.kid, typ: 'example' });
  const verified = verifyStatement(signed.value, 'example', [k.jwk], NOW);
  assert.deepEqual(verified, { ok: true, value: claims() });
  assert.deepEqual(signStatement('example', claims(), k), signed, 'equal claims sign the same bytes');
});

test('a statement of another type, from another key, altered or expired is refused', () => {
  const k = key();
  const other = key();
  const signed = signStatement('example', claims(), k);
  if (!signed.ok) assert.fail('not signed');
  assert.deepEqual(verifyStatement(signed.value, 'other-kind', [k.jwk], NOW), { ok: false, error: { reason: 'wrong-type' } });
  assert.deepEqual(verifyStatement(signed.value, 'example', [other.jwk], NOW), { ok: false, error: { reason: 'unknown-key' } });
  const [h, , s] = signed.value.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims(), about: 'more' })).toString('base64url')}.${s}`;
  assert.deepEqual(verifyStatement(forged, 'example', [k.jwk], NOW), { ok: false, error: { reason: 'bad-signature' } });
  const expired = signStatement('example', claims(seconds(NOW)), k);
  assert.ok(expired.ok);
  assert.deepEqual(verifyStatement(expired.value, 'example', [k.jwk], NOW), { ok: false, error: { reason: 'expired' } });
  assert.deepEqual(verifyStatement('not.a.statement!', 'example', [k.jwk], NOW), { ok: false, error: { reason: 'malformed' } });
  // A header claiming another algorithm is refused outright, whatever its signature.
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: k.kid, typ: 'example' })).toString('base64url')}.${signed.value.split('.')[1]}.${s}`;
  assert.deepEqual(verifyStatement(none, 'example', [k.jwk], NOW), { ok: false, error: { reason: 'malformed' } });
});

test('a statement longer than its limit is not made', () => {
  const big = signStatement('example', { ...claims(), padding: 'x'.repeat(9000) }, key());
  assert.equal(big.ok, false);
  assert.equal(!big.ok && big.error.reason, 'too-large');
});

test('only an Ed25519 private key is a signing key, and a refusal never quotes what it was given', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.deepEqual(signingKeyFrom(rsa), { ok: false, error: { reason: 'not-ed25519' } });
  assert.deepEqual(signingKeyFrom('-----BEGIN PRIVATE KEY-----\nsecret-ish\n-----END PRIVATE KEY-----'), { ok: false, error: { reason: 'unreadable' } });
});

test('a web grant is a statement of type vault-grant, and only that', () => {
  const k = key();
  const grant: GrantClaims = {
    iss: 'alice@homeserver', jti: '01KABCDEFGHJKMNPQRSTVWXYZ0', aud: 'script', iat: seconds(NOW), exp: seconds(NOW) + 600,
    vault: 'home', job: 'jobs/a.md', blob: 'a'.repeat(40), main: 'b'.repeat(40), requests: 3, allow: [{ url: 'https://example.net/*' }],
  };
  const signed = signGrant(grant, k);
  if (!signed.ok) assert.fail('not signed');
  assert.deepEqual(verifyGrant(signed.value, [k.jwk], NOW), { ok: true, value: grant });
  const notAGrant = signStatement('example', grant as unknown as Record<string, unknown>, k);
  assert.ok(notAGrant.ok);
  assert.deepEqual(verifyGrant(notAGrant.value, [k.jwk], NOW), { ok: false, error: { reason: 'wrong-type' } }, `only ${GRANT_TYPE} statements are grants`);
});
