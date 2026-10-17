// The trailers on commits the package makes (concepts.md "Actor"): which trace
// and actor made a commit, from which Pi session, and whether that session was
// tainted.
//
// Taint fails closed: a commit counts as tainted when it says so, and also when
// it does not carry the package's trace trailer at all — a commit made outside
// the package cannot vouch that its author read nothing untrusted.

import type { Trailer } from '../git/index.ts';

export const TRAILER = {
  trace: 'Vault-Trace',
  actor: 'Vault-Actor',
  session: 'Vault-Session',
  tainted: 'Vault-Tainted',
} as const;

export interface CommitOrigin {
  readonly trace: string;
  readonly actor: string;
  /** The Pi session the commit was made from, if any. */
  readonly session?: string;
  readonly tainted?: boolean;
}

/** The trailers for a package commit, in a fixed order. */
export function packageTrailers(origin: CommitOrigin): Trailer[] {
  return [
    { key: TRAILER.trace, value: origin.trace },
    { key: TRAILER.actor, value: origin.actor },
    ...(origin.session === undefined ? [] : [{ key: TRAILER.session, value: origin.session }]),
    ...(origin.tainted === true ? [{ key: TRAILER.tainted, value: 'yes' }] : []),
  ];
}

/** The value of a trailer — its last occurrence, compared case-insensitively as Git does — or undefined. */
export function trailerValue(commit: { readonly trailers: readonly Trailer[] }, key: string): string | undefined {
  const wanted = key.toLowerCase();
  return commit.trailers.findLast((t) => t.key.toLowerCase() === wanted)?.value;
}

export function isTaintedCommit(commit: { readonly trailers: readonly Trailer[] }): boolean {
  return trailerValue(commit, TRAILER.tainted) !== undefined || trailerValue(commit, TRAILER.trace) === undefined;
}
