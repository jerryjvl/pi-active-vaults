// Index upkeep (daemon.md "Index upkeep"): each tick, every vault on the
// machine whose accepted `main` is not the commit its index was built at is
// brought up to it — after an owner's accept, a merge fetched from the forge, a
// first registration — so search never lags what was accepted.
//
// Invariants:
//  - only an accepted main is indexed (search/update.ts refuses otherwise), so a
//    paused vault waits, and a vault with nothing accepted is left alone;
//  - an update runs in the background, at most one per vault at a time, and the
//    tick never waits for it: embedding a large vault takes minutes;
//  - an update whose vectors failed (the embedding model unreachable) is tried
//    again after RETRY_MS, not every minute; the index's text part is already
//    current, so keyword search works meanwhile. Vectors left missing by an
//    earlier daemon (stopped mid-embedding) get one attempt on its first look
//    at the vault; a vault with no embedding model is never retried;
//  - the outcome of each vault's last update is kept for `daemon status`, only
//    while the daemon runs.

import { acceptedMain } from '../integrity/index.ts';
import type { OperationContext } from '../operations/index.ts';
import { searchContext } from '../operations/ops/common.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { documentsWithoutVectors, updateIndex, type IndexReport } from '../search/index.ts';

/** How long after an update whose vectors failed it is tried again. */
export const RETRY_MS = 15 * 60_000;

export interface IndexingStatus {
  readonly vault: string;
  readonly at: string;
  /** The commit the index was brought to. */
  readonly sha?: string;
  readonly added?: number;
  readonly changed?: number;
  readonly removed?: number;
  /** Why it did not finish, or why its vectors did not. */
  readonly error?: string;
}

export interface Indexing {
  tick(vaults: readonly RegisteredVault[]): void;
  /** Resolves once no update is running (tests, and stopping). */
  idle(): Promise<void>;
  outcomes(): IndexingStatus[];
}

export function createIndexing(context: OperationContext): Indexing {
  const running = new Map<string, Promise<void>>();
  const outcomes = new Map<string, IndexingStatus>();
  const retryAfter = new Map<string, number>();
  const seen = new Set<string>();

  const indexedAt = (vault: string): string | undefined => {
    const index = context.index();
    if (!index.ok) return undefined;
    return index.value.all<{ sha: string }>('SELECT sha FROM search_vaults WHERE vault = ?', [vault])[0]?.sha;
  };

  const due = (vault: RegisteredVault): boolean => {
    if (running.has(vault.id)) return false;
    const accepted = acceptedMain(context.state, vault.id);
    if (accepted === undefined) return false;
    if (!seen.has(vault.id)) {
      seen.add(vault.id);
      // Vectors an earlier daemon did not finish (stopped mid-embedding, model down): one attempt now.
      const index = context.index();
      if (index.ok && documentsWithoutVectors(index.value, vault.id).length > 0) retryAfter.set(vault.id, context.clock.now().getTime());
    }
    if (indexedAt(vault.id) !== accepted.sha) return true;
    const retry = retryAfter.get(vault.id);
    return retry !== undefined && context.clock.now().getTime() >= retry;
  };

  const update = async (vault: RegisteredVault): Promise<void> => {
    const index = context.index();
    if (!index.ok) return;
    const at = context.clock.now();
    const done = await updateIndex(searchContext(context, index.value), vault);
    if (!done.ok) {
      // Paused since the tick looked (an unaccepted change), or a Git error: the next tick sees it again.
      outcomes.set(vault.id, { vault: vault.id, at: at.toISOString(), error: done.error.reason });
      return;
    }
    const report: IndexReport = done.value;
    const vectors = report.vectors.state === 'failed' ? `vectors: ${report.vectors.error.reason}` : undefined;
    if (vectors === undefined) retryAfter.delete(vault.id);
    else retryAfter.set(vault.id, at.getTime() + RETRY_MS);
    outcomes.set(vault.id, {
      vault: vault.id, at: at.toISOString(), sha: report.sha,
      added: report.added.length, changed: report.changed.length, removed: report.removed.length,
      ...(vectors === undefined ? {} : { error: vectors }),
    });
  };

  return {
    tick(vaults) {
      if (!context.index().ok) return;
      for (const vault of vaults) {
        if (!due(vault)) continue;
        const job = update(vault).catch((e: unknown) => {
          outcomes.set(vault.id, { vault: vault.id, at: context.clock.now().toISOString(), error: e instanceof Error ? e.message : String(e) });
        }).finally(() => running.delete(vault.id));
        running.set(vault.id, job);
      }
    },
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
    outcomes: () => [...outcomes.values()],
  };
}
