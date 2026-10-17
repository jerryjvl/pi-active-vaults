// Adopting an unaccepted change: the owner act that resolves one by accepting
// what `main` now holds (security.md "Unexpected changes"). It lives beside
// accept because, like accept, it composes policy over the delta before
// `integrity` records the result.
//
// What is recorded is exactly what was shown. The delta from the accepted
// `main` to a commit carries, first, its concerns — checks on the accepted
// `main` that have not passed for that commit, and control changes — then its
// commits, its diff, and whether history was rewritten. When there are
// concerns, the owner must acknowledge them: the delta carries an
// acknowledgement, a digest of the commit and its concerns, and adopting
// requires that same digest, so concerns that changed since they were shown
// are not acknowledged. Then, once the owner confirms that same full SHA,
// it is recorded, if it is still `main`'s tip.
//
// The owners, review mode and checks come from the accepted `main` (from the
// adopted commit only when nothing was accepted yet: the first adoption of a
// newly registered vault, where every contract and script is a control
// change). Forge-mode vaults are never adopted locally; they are resolved by
// syncing with the forge.

import { createHash } from 'node:crypto';
import { readAttestations, type AttestationError } from '../attestations/index.ts';
import type { Clock } from '../clock/index.ts';
import {
  changedPaths, commitsBetween, diffText, isAncestor, isSha, resolveRevision, type CommitInfo, type Git, type GitError, type Sha,
} from '../git/index.ts';
import { acceptedMain, mainTip, recordAccepted, type AcceptedMain, type VaultLocation } from '../integrity/index.ts';
import { checkStatuses, findControlChanges, type CheckStatus, type ControlChange } from '../policy/index.ts';
import { isOwner, readVaultIdentity, type IdentityError } from '../registry/index.ts';
import { canonicalJson, err, ok, type Result } from '../result/index.ts';
import { listScripts } from '../scripts/index.ts';
import type { Store } from '../store/index.ts';

export interface AdoptionConcerns {
  /** Checks on the accepted main whose result for the commit is not `pass` (failed, missing, stale or unusable). */
  readonly checks: readonly CheckStatus[];
  readonly control: readonly ControlChange[];
}

export interface AdoptionDelta {
  /** The accepted main the delta starts from; absent when nothing was accepted yet. */
  readonly from?: AcceptedMain;
  readonly to: Sha;
  /** Shown first; when there are any, adopting needs `acknowledgement`. */
  readonly concerns: AdoptionConcerns;
  readonly acknowledgement?: string;
  readonly commits: readonly CommitInfo[];
  /** The accepted main is not part of `to`'s history. */
  readonly rewritten: boolean;
  readonly diff: string;
}

export type AdoptionError = GitError | AttestationError;

/** Checks that have not passed for `to`; none can be resolved when nothing was accepted yet. */
async function unpassedChecks(git: Git, repo: string, from: AcceptedMain | undefined, to: Sha): Promise<Result<CheckStatus[], AdoptionError>> {
  if (from === undefined) return ok([]);
  const checks = await listScripts(git, repo, from, { kind: 'check', builtins: [] });
  if (!checks.ok) return checks;
  const attestations = await readAttestations(git, repo, to);
  if (!attestations.ok) return attestations;
  const statuses = checkStatuses({
    subject: to,
    checks: checks.value.scripts.map((check) => ({ name: check.name, version: check.version })),
    invalidChecks: checks.value.invalid.map((check) => check.name),
    attestations: { commit: attestations.value, content: new Map() },
  });
  return ok(statuses.filter((check) => check.status !== 'pass'));
}

/** Where the delta starts and what must be acknowledged: the part of a delta that adopting re-checks. */
interface Assessment {
  readonly from?: AcceptedMain;
  /** What the delta is diffed from; null when the accepted main is gone or there is none. */
  readonly base: Sha | null;
  readonly rewritten: boolean;
  readonly concerns: AdoptionConcerns;
  readonly acknowledgement?: string;
}

async function assess(git: Git, store: Store, vault: VaultLocation, to: Sha): Promise<Result<Assessment, AdoptionError>> {
  const from = acceptedMain(store, vault.id);
  let base: Sha | null = null;
  let rewritten = false;
  if (from !== undefined) {
    const contained = await isAncestor(git, vault.path, from.sha, to);
    if (!contained.ok && contained.error.reason !== 'unknown-revision') return contained;
    rewritten = !contained.ok || !contained.value;
    // A recorded commit that no longer exists cannot be diffed against.
    if (contained.ok) base = from.sha;
  }
  const changes = await changedPaths(git, vault.path, base, to);
  if (!changes.ok) return changes;
  const control = await findControlChanges(git, vault.path, base, to, changes.value);
  if (!control.ok) return control;
  const checks = await unpassedChecks(git, vault.path, from, to);
  if (!checks.ok) return checks;
  const concerns: AdoptionConcerns = { checks: checks.value, control: control.value };
  const none = concerns.checks.length === 0 && concerns.control.length === 0;
  const acknowledgement = none ? undefined : createHash('sha256').update(canonicalJson({ from: from?.sha ?? null, to, concerns })).digest('hex');
  return ok({ ...(from === undefined ? {} : { from }), base, rewritten, concerns, ...(acknowledgement === undefined ? {} : { acknowledgement }) });
}

export async function adoptionDelta(git: Git, store: Store, vault: VaultLocation, revision: string): Promise<Result<AdoptionDelta, AdoptionError>> {
  const to = await resolveRevision(git, vault.path, revision);
  if (!to.ok) return to;
  const assessed = await assess(git, store, vault, to.value);
  if (!assessed.ok) return assessed;
  const { base, ...shown } = assessed.value;
  const commits = await commitsBetween(git, vault.path, base, to.value);
  if (!commits.ok) return commits;
  const diff = await diffText(git, vault.path, base, to.value);
  if (!diff.ok) return diff;
  return ok({ ...shown, to: to.value, commits: commits.value, diff: diff.value });
}

export type AdoptError =
  | AdoptionError
  | IdentityError
  | { readonly reason: 'not-main-tip'; readonly tip: Sha | null }
  | { readonly reason: 'not-owner'; readonly approver: string }
  | { readonly reason: 'forge-mode' }
  | { readonly reason: 'unacknowledged'; readonly concerns: AdoptionConcerns }
  | { readonly reason: 'accepted-moved'; readonly current: Sha | null };

export interface AdoptRequest {
  readonly sha: Sha;
  readonly approver: string;
  readonly clock: Clock;
  /** The delta's `acknowledgement`, when it had concerns. */
  readonly acknowledged?: string | undefined;
}

export async function adopt(git: Git, store: Store, vault: VaultLocation, request: AdoptRequest): Promise<Result<AcceptedMain, AdoptError>> {
  if (!isSha(request.sha)) return err({ reason: 'invalid-argument', argument: 'sha' });
  const tip = await mainTip(git, vault.path);
  if (!tip.ok) return tip;
  if (tip.value !== request.sha) return err({ reason: 'not-main-tip', tip: tip.value });

  const current = acceptedMain(store, vault.id);
  const identity = await readVaultIdentity(git, vault.path, current?.sha ?? request.sha);
  if (!identity.ok) return identity;
  if (identity.value.review === 'forge') return err({ reason: 'forge-mode' });
  if (!isOwner(identity.value, request.approver)) return err({ reason: 'not-owner', approver: request.approver });

  // The concerns now, not as they were shown: an acknowledgement covers only what it was made for.
  const assessed = await assess(git, store, vault, request.sha);
  if (!assessed.ok) return assessed;
  if (assessed.value.acknowledgement !== undefined && assessed.value.acknowledgement !== request.acknowledged) {
    return err({ reason: 'unacknowledged', concerns: assessed.value.concerns });
  }

  return recordAccepted(store, vault.id, { sha: request.sha, how: 'adopt', by: request.approver, at: request.clock.now() }, current?.sha ?? null);
}
