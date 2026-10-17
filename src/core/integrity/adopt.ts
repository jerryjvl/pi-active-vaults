// Adopting an unaccepted change: the owner act that resolves one by accepting
// what `main` now holds (security.md "Unexpected changes").
//
// It is two steps, so that what is recorded is exactly what was shown: the
// delta from the accepted `main` to a commit — its commits, its diff, and
// whether history was rewritten — and then, once the owner confirms that same
// full SHA, recording it. The SHA must still be `main`'s tip when confirmed.
// The owners and review mode come from the accepted `main` (from the adopted
// commit only when nothing was accepted yet: the first adoption of a newly
// registered vault). Forge-mode vaults are never adopted locally; they are
// resolved by syncing with the forge.

import type { Clock } from '../clock/index.ts';
import { commitsBetween, diffText, isAncestor, isSha, resolveRevision, type CommitInfo, type Git, type GitError, type Sha } from '../git/index.ts';
import { isOwner, readVaultIdentity, type IdentityError } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { acceptedMain, recordAccepted, type AcceptedMain } from './accepted.ts';
import { mainTip, type VaultLocation } from './status.ts';

export interface AdoptionDelta {
  /** The accepted main the delta starts from; absent when nothing was accepted yet. */
  readonly from?: AcceptedMain;
  readonly to: Sha;
  readonly commits: readonly CommitInfo[];
  /** The accepted main is not part of `to`'s history. */
  readonly rewritten: boolean;
  readonly diff: string;
}

export async function adoptionDelta(git: Git, store: Store, vault: VaultLocation, revision: string): Promise<Result<AdoptionDelta, GitError>> {
  const to = await resolveRevision(git, vault.path, revision);
  if (!to.ok) return to;
  const from = acceptedMain(store, vault.id);
  let base: Sha | null = null;
  let rewritten = false;
  if (from !== undefined) {
    const contained = await isAncestor(git, vault.path, from.sha, to.value);
    if (!contained.ok && contained.error.reason !== 'unknown-revision') return contained;
    rewritten = !contained.ok || !contained.value;
    // A recorded commit that no longer exists cannot be diffed against.
    if (contained.ok) base = from.sha;
  }
  const commits = await commitsBetween(git, vault.path, base, to.value);
  if (!commits.ok) return commits;
  const diff = await diffText(git, vault.path, base, to.value);
  if (!diff.ok) return diff;
  return ok({ ...(from === undefined ? {} : { from }), to: to.value, commits: commits.value, rewritten, diff: diff.value });
}

export type AdoptError =
  | GitError
  | IdentityError
  | { readonly reason: 'not-main-tip'; readonly tip: Sha | null }
  | { readonly reason: 'not-owner'; readonly approver: string }
  | { readonly reason: 'forge-mode' }
  | { readonly reason: 'accepted-moved'; readonly current: Sha | null };

export async function adopt(
  git: Git, store: Store, vault: VaultLocation, request: { readonly sha: Sha; readonly approver: string; readonly clock: Clock },
): Promise<Result<AcceptedMain, AdoptError>> {
  if (!isSha(request.sha)) return err({ reason: 'invalid-argument', argument: 'sha' });
  const tip = await mainTip(git, vault.path);
  if (!tip.ok) return tip;
  if (tip.value !== request.sha) return err({ reason: 'not-main-tip', tip: tip.value });

  const current = acceptedMain(store, vault.id);
  const identity = await readVaultIdentity(git, vault.path, current?.sha ?? request.sha);
  if (!identity.ok) return identity;
  if (identity.value.review === 'forge') return err({ reason: 'forge-mode' });
  if (!isOwner(identity.value, request.approver)) return err({ reason: 'not-owner', approver: request.approver });

  return recordAccepted(store, vault.id, { sha: request.sha, how: 'adopt', by: request.approver, at: request.clock.now() }, current?.sha ?? null);
}
