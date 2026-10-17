// Freshness (core.md "Search"): whether an indexed document still reads as it
// did when it was indexed, judged against the vault's accepted `main` now —
// `current` (the same blob), `changed` (another blob at the same path),
// `moved` (renamed since, followed from the indexed commit) or `gone`. A vault
// with no accepted `main` has nothing current.

import { changedPaths, listTree, type Git, type GitError, type Sha } from '../git/index.ts';
import { acceptedMain, type VaultLocation } from '../integrity/index.ts';
import { ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';

export type Freshness = 'current' | 'changed' | 'moved' | 'gone';

export interface FreshnessVerdict {
  readonly freshness: Freshness;
  /** Where a moved document is now. */
  readonly movedTo?: string;
}

interface VaultView {
  readonly accepted: Sha | undefined;
  readonly blobs: ReadonlyMap<string, string>;
  /** Old path → new path, from the indexed commit to the accepted main; read when first needed. */
  renames?: ReadonlyMap<string, string>;
}

/** Checks documents against each vault's accepted main, reading each vault's tree once. */
export function freshnessChecker(git: Git, state: Queryable): (vault: VaultLocation, indexedAt: Sha, path: string, blob: string) => Promise<Result<FreshnessVerdict, GitError>> {
  const views = new Map<string, VaultView>();

  const view = async (vault: VaultLocation): Promise<Result<VaultView, GitError>> => {
    const known = views.get(vault.id);
    if (known !== undefined) return ok(known);
    const accepted = acceptedMain(state, vault.id)?.sha;
    let blobs = new Map<string, string>();
    if (accepted !== undefined) {
      const tree = await listTree(git, vault.path, accepted);
      if (!tree.ok) return tree;
      blobs = new Map(tree.value.map((entry) => [entry.path, entry.sha]));
    }
    const made: VaultView = { accepted, blobs };
    views.set(vault.id, made);
    return ok(made);
  };

  return async (vault, indexedAt, path, blob) => {
    const seen = await view(vault);
    if (!seen.ok) return seen;
    const { accepted, blobs } = seen.value;
    if (accepted === undefined) return ok({ freshness: 'gone' });
    const now = blobs.get(path);
    if (now !== undefined) return ok({ freshness: now === blob ? 'current' : 'changed' });
    if (seen.value.renames === undefined) {
      const changes = await changedPaths(git, vault.path, indexedAt, accepted);
      if (!changes.ok) return changes;
      seen.value.renames = new Map(changes.value.flatMap((c) => (c.change === 'renamed' && c.oldPath !== undefined ? [[c.oldPath, c.path]] : [])));
    }
    const movedTo = seen.value.renames.get(path);
    return ok(movedTo !== undefined && blobs.has(movedTo) ? { freshness: 'moved', movedTo } : { freshness: 'gone' });
  };
}
