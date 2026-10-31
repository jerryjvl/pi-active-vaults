// Signed statements (components/signer.md "Statements"): a compact JWS (RFC
// 7515) signed with Ed25519 (`EdDSA`, RFC 8037) — the one format in which a
// process holding the signing key vouches for something to a process that
// holds only the public key. Each kind of statement has a type of its own
// (`typ`), and a verifier names the one type it accepts, so a statement made
// for one purpose is never taken for another.
//
// Invariants:
//  - only the private key is secret; a statement allows only what it says,
//    until it expires, so it may travel openly;
//  - the header is exactly `alg: EdDSA`, the key's ID and the type, so a
//    verifier refuses any other algorithm outright instead of trusting a
//    header;
//  - claims are canonical JSON, so equal claims always sign the same bytes;
//  - a statement longer than its limit is not made: statements travel in
//    headers and environment variables, which are bounded.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, err, isRecord, ok, type Result } from '../result/index.ts';

/** The longest statement made by default, in bytes: what an HTTP header or an environment variable safely carries. */
export const STATEMENT_MAX_BYTES = 8 * 1024;

export interface PublicJwk {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
  readonly kid: string;
}

export interface SigningKey {
  readonly privateKey: KeyObject;
  /** The key's ID: the first 16 characters of the base64url SHA-256 of its raw public key. */
  readonly kid: string;
  /** The public key, for verifiers' configuration. */
  readonly jwk: PublicJwk;
}

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');
const JWS_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function publicJwk(publicKey: KeyObject): PublicJwk {
  const x = publicKey.export({ format: 'jwk' }).x ?? '';
  const kid = createHash('sha256').update(Buffer.from(x, 'base64url')).digest('base64url').slice(0, 16);
  return { kty: 'OKP', crv: 'Ed25519', x, kid };
}

/** The signing key in a PEM text; `not-ed25519` for any other key, `unreadable` for anything that is not a private key. */
export function signingKeyFrom(pem: string): Result<SigningKey, { readonly reason: 'unreadable' | 'not-ed25519' }> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    // The parser's message may quote the text, which may be a key.
    return err({ reason: 'unreadable' });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') return err({ reason: 'not-ed25519' });
  const jwk = publicJwk(createPublicKey(privateKey));
  return ok({ privateKey, kid: jwk.kid, jwk });
}

/** A new signing key: its private key as PEM (PKCS #8), and its public JWK. */
export function newSigningKey(): { readonly pem: string; readonly jwk: PublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), jwk: publicJwk(publicKey) };
}

/** A statement of type `typ` making `claims`, or `too-large` when it would be longer than `maxBytes`. */
export function signStatement(
  typ: string, claims: Readonly<Record<string, unknown>>, key: SigningKey, maxBytes = STATEMENT_MAX_BYTES,
): Result<string, { readonly reason: 'too-large'; readonly bytes: number }> {
  const header = base64url(canonicalJson({ alg: 'EdDSA', kid: key.kid, typ }));
  const payload = base64url(canonicalJson(claims));
  const signature = base64url(sign(null, Buffer.from(`${header}.${payload}`), key.privateKey));
  const token = `${header}.${payload}.${signature}`;
  const bytes = Buffer.byteLength(token);
  return bytes > maxBytes ? err({ reason: 'too-large', bytes }) : ok(token);
}

/** Whether `text` has the shape of a statement within `maxBytes`; it says nothing of its signature. */
export function isStatementShaped(text: unknown, maxBytes = STATEMENT_MAX_BYTES): text is string {
  return typeof text === 'string' && Buffer.byteLength(text) <= maxBytes && JWS_SHAPE.test(text);
}

export type VerifyError = { readonly reason: 'malformed' | 'wrong-type' | 'unknown-key' | 'bad-signature' | 'expired' };

/**
 * The claims of a statement of type `typ`, signed by one of `keys` and not
 * expired at `now` (its `exp`, in seconds since the epoch). What a verifier
 * does — here so the format has one reference implementation.
 */
export function verifyStatement(token: string, typ: string, keys: readonly PublicJwk[], now: Date): Result<Record<string, unknown>, VerifyError> {
  if (!isStatementShaped(token)) return err({ reason: 'malformed' });
  const [header = '', payload = '', signature = ''] = token.split('.');
  let head: unknown;
  let claims: unknown;
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return err({ reason: 'malformed' });
  }
  if (!isRecord(head) || head['alg'] !== 'EdDSA' || !isRecord(claims)) return err({ reason: 'malformed' });
  if (head['typ'] !== typ) return err({ reason: 'wrong-type' });
  const jwk = keys.find((k) => k.kid === head['kid']);
  if (jwk === undefined) return err({ reason: 'unknown-key' });
  const publicKey = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  if (!verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))) return err({ reason: 'bad-signature' });
  if (typeof claims['exp'] !== 'number' || claims['exp'] <= Math.floor(now.getTime() / 1000)) return err({ reason: 'expired' });
  return ok(claims);
}
