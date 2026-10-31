// Public surface of the grants module: web grants (concepts.md "Web grants") —
// a job's `web` block, the signed grant a run carries, web grants as a kind of
// statement the signer makes, and handing grants to a run's scripts and
// fan-out items.

export {
  WEB_LIMITS, itemEntries, parseWebBlock, selectivityIssues,
  type PlaceholderRule, type WebAllowance, type WebEntry,
} from './allowance.ts';
export { GRANT_HEADER, GRANT_TYPE, GRANT_VARIABLE, isGrantShaped, signGrant, verifyGrant, type GrantClaims } from './token.ts';
export { WEB_GRANT_KIND, grantsSchema, parseGrantRequest, webGrantKind, type GrantRequest, type IssuedGrants } from './kind.ts';
export {
  parseRunGrants, pingSigner, requestGrants, withGrantHeader,
  type GrantRequestError, type RunGrants, type SignerStatus,
} from './request.ts';
