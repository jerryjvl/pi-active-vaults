// A web grant as it travels (concepts.md "Web grants"): a signed statement
// (signing module) of type `vault-grant`, whose claims are one run's
// allowance and what it was signed from. The signer makes them; the web
// broker verifies them against the public keys it is configured with.
//
// A grant is a capability, not a secret: it allows only what its entries
// allow, until it expires.

import { isStatementShaped, signStatement, verifyStatement, type PublicJwk, type SigningKey, type VerifyError } from '../signing/index.ts';
import type { Result } from '../result/index.ts';
import type { PlaceholderRule } from './allowance.ts';

/** The statement type of a web grant: a verifier accepts no other. */
export const GRANT_TYPE = 'vault-grant';
/** The environment variable a run's scripts find their grant in. */
export const GRANT_VARIABLE = 'VAULT_WEB_GRANT';
/** The HTTP header a fan-out item's MCP requests carry their grant in. */
export const GRANT_HEADER = 'X-Vault-Grant';

export interface GrantClaims {
  /** The installation that signed it. */
  readonly iss: string;
  /** The run's trace: the grant's ID, shared by a run's grants so the broker counts their requests together. */
  readonly jti: string;
  /** Who may present it: the run's scripts (every entry), or its fan-out items (closed entries and `to: all`). */
  readonly aud: 'script' | 'item';
  /** Issued and expires, in seconds since the epoch. */
  readonly iat: number;
  readonly exp: number;
  readonly vault: string;
  readonly job: string;
  /** The job's blob and the commit of `main` it was read from. */
  readonly blob: string;
  readonly main: string;
  readonly requests: number;
  readonly allow: readonly { readonly url: string; readonly params?: Readonly<Record<string, PlaceholderRule>> }[];
}

export function signGrant(claims: GrantClaims, key: SigningKey): Result<string, { readonly reason: 'too-large'; readonly bytes: number }> {
  return signStatement(GRANT_TYPE, claims as unknown as Readonly<Record<string, unknown>>, key);
}

/** Whether `text` has the shape of a grant and fits where grants travel; it says nothing of its signature. */
export const isGrantShaped = (text: unknown): text is string => isStatementShaped(text);

/** The claims of a grant signed by one of `keys` and not expired at `now`: what a broker checks. */
export function verifyGrant(token: string, keys: readonly PublicJwk[], now: Date): Result<GrantClaims, VerifyError> {
  return verifyStatement(token, GRANT_TYPE, keys, now) as Result<GrantClaims, VerifyError>;
}
