// Public surface of the signing module: signed statements between processes
// that do not share a key (components/signer.md) — the statement format, the
// signer's protocol and key, and its own view of a vault. What is stated is
// each kind's own module's (web grants: grants).

export {
  STATEMENT_MAX_BYTES, isStatementShaped, newSigningKey, signStatement, signingKeyFrom, verifyStatement,
  type PublicJwk, type SigningKey, type VerifyError,
} from './token.ts';
export {
  answerSignerMessage, fetchSignerMain, signingKeyOf,
  type SignRefusal, type SignerDeps, type SignerReply, type StatementKind,
} from './service.ts';
