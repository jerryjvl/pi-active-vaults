// The accepted `main` per vault: the commit an owner last accepted — produced
// by `vault accept`, adopted, created by `vault init`, or (in forge mode)
// fetched from the forge, which enforces review there (security.md).
//
// This module is the only reader and writer of it. `AcceptedMain` is branded
// so that only this module can produce one: anything that resolves
// executable or instructional content takes an `AcceptedMain`, so it cannot be
// handed an arbitrary commit by mistake.

import { isSha, type Sha } from '../git/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Queryable, Store } from '../store/index.ts';

declare const acceptedBrand: unique symbol;

export const ACCEPTED_HOW = ['init', 'accept', 'adopt', 'sync'] as const;
export type AcceptedHow = (typeof ACCEPTED_HOW)[number];

export interface AcceptedMain {
  readonly vault: string;
  readonly sha: Sha;
  /** The owner act that recorded it. */
  readonly how: AcceptedHow;
  /** The owner who accepted it (for `sync`, the forge account it was fetched as). */
  readonly by: string;
  /** When (ISO 8601). */
  readonly at: string;
  readonly [acceptedBrand]: true;
}

export const integritySchema: ModuleSchema = {
  module: 'integrity',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE integrity_accepted (
        vault TEXT PRIMARY KEY,
        sha TEXT NOT NULL,
        how TEXT NOT NULL CHECK (how IN ('init', 'accept', 'adopt', 'sync')),
        by TEXT NOT NULL,
        at TEXT NOT NULL
      ) STRICT`,
    },
  ],
};

type Row = { vault: string; sha: string; how: AcceptedHow; by: string; at: string };

export function acceptedMain(store: Queryable, vault: string): AcceptedMain | undefined {
  return store.get<Row>('SELECT vault, sha, how, by, at FROM integrity_accepted WHERE vault = ?', [vault]) as AcceptedMain | undefined;
}

/**
 * Records `sha` as the vault's accepted main, only if the accepted main is
 * still `expected` (null: none yet) — so two owner acts racing cannot
 * silently overwrite each other.
 */
export function recordAccepted(
  store: Store,
  vault: string,
  record: { readonly sha: Sha; readonly how: AcceptedHow; readonly by: string; readonly at: Date },
  expected: Sha | null,
): Result<AcceptedMain, { readonly reason: 'accepted-moved'; readonly current: Sha | null }> {
  if (!isSha(record.sha) || (expected !== null && !isSha(expected))) {
    throw new Error('the accepted main is recorded by full SHA only');
  }
  const row: Row = { vault, sha: record.sha, how: record.how, by: record.by, at: record.at.toISOString() };
  return store.transaction((tx) => {
    const current = acceptedMain(tx, vault)?.sha ?? null;
    if (current !== expected) return err({ reason: 'accepted-moved', current });
    tx.run(
      `INSERT INTO integrity_accepted (vault, sha, how, by, at) VALUES ($vault, $sha, $how, $by, $at)
       ON CONFLICT (vault) DO UPDATE SET sha = excluded.sha, how = excluded.how, by = excluded.by, at = excluded.at`,
      row,
    );
    return ok(row as AcceptedMain);
  });
}
