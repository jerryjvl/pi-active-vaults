// Bringing an actor's branch up to date with the accepted `main` (cli.md
// `vault sync`): the accepted `main`, never `main`'s tip, since nothing may
// be built on content no owner accepted.
//
// A branch with no work of its own moves forward to it. A branch with work
// gets a merge commit in the actor's worktree, carrying the package's
// trailers — a commit without them counts as outside work, which taints a
// proposal — and, like any new head, assessed by every check on the accepted
// `main`, whose verdicts are recorded (the merge is already made; a failing
// check then stands against the proposal until it is fixed). A caller may ask
// for no merge (`merge: false`): a branch with work of its own is then left as
// it is (`left-ahead`), which is how an owner's open proposal in forge mode is
// kept the commit the owner approves (operations/ops/proposals.ts). Syncing writes
// as the actor: not while another session holds it, and never over
// uncommitted changes in its worktree.
//
// A merge that conflicts is undone, and the branch cannot be synced until an
// owner resolves it by hand. `syncConflict` finds such a branch by a trial
// merge that touches nothing, so the daemon can tell the owners before a job
// or a pull request runs into it (a sync that meets one returns it the same
// way, as `sync-conflict`); `conflictNotice` is the one wording of what
// conflicts and how to resolve it, for every surface that reports it.

import {
  addTrailers, fastForward, hasTrackedChanges, isAncestor, listWorktrees, mergeConflicts, mergeSha, resolveRevision, updateRef,
  type Git, type GitError, type Identity, type Sha,
} from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import type { RegisteredVault, VaultIdentity } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { recordCheckResults, runChecks, type CheckResult } from '../scripts/index.ts';
import { heldByAnother, type Holder } from './holds.ts';
import { packageTrailers, type CommitOrigin } from './trailers.ts';
import { actorBranch, actorWorktreePath, ensureActorWorktree, type ActorCommitContext, type ActorCommitError, type WorktreeError } from './worktrees.ts';

export interface SyncRequest {
  readonly origin: CommitOrigin;
  /** The injected clock's time, for a merge commit. */
  readonly date: Date;
  readonly identity?: Identity;
  /** The syncing session's own hold, when it has one. */
  readonly holder?: Holder;
  /** Merge the accepted main into a branch with work of its own (default true); false leaves it `left-ahead`. */
  readonly merge?: boolean;
}

export interface SyncOutcome {
  readonly outcome: 'no-branch' | 'up-to-date' | 'fast-forwarded' | 'merged' | 'left-ahead' | 'uncommitted-changes';
  /** The branch's head afterwards. */
  readonly head?: Sha;
  /** For a merge: every check's verdict on it. */
  readonly checks?: readonly CheckResult[];
}

/** A merge that conflicts carries the conflict, so a caller can say what conflicts and how to resolve it. */
export type SyncError = ActorCommitError | WorktreeError | { readonly reason: 'sync-conflict'; readonly conflict: SyncConflict };

export async function syncActorBranch(
  context: ActorCommitContext, vault: RegisteredVault, accepted: AcceptedMain, actor: string, request: SyncRequest,
): Promise<Result<SyncOutcome, SyncError>> {
  const { git } = context;
  const ref = `refs/heads/${actorBranch(actor)}`;
  const tip = await resolveRevision(git, vault.path, ref);
  if (!tip.ok) return tip.error.reason === 'unknown-revision' ? ok({ outcome: 'no-branch' }) : tip;
  const current = await isAncestor(git, vault.path, accepted.sha, tip.value);
  if (!current.ok) return current;
  if (current.value) return ok({ outcome: 'up-to-date', head: tip.value });

  const hold = await heldByAnother(context.store, context.alive, vault.id, actor, request.holder);
  if (hold !== undefined) return err({ reason: 'actor-busy', hold });

  const behind = await isAncestor(git, vault.path, tip.value, accepted.sha);
  if (!behind.ok) return behind;
  if (behind.value) {
    const worktrees = await listWorktrees(git, vault.path);
    if (!worktrees.ok) return worktrees;
    const checkout = worktrees.value.find((w) => w.branch === actorBranch(actor));
    if (checkout === undefined) {
      const moved = await updateRef(git, vault.path, ref, accepted.sha, tip.value);
      return moved.ok ? ok({ outcome: 'fast-forwarded', head: accepted.sha }) : moved;
    }
    const forwarded = await fastForward(git, checkout.path, accepted.sha);
    if (forwarded.ok) return ok({ outcome: 'fast-forwarded', head: accepted.sha });
    return forwarded.error.reason === 'dirty-worktree' ? ok({ outcome: 'uncommitted-changes', head: tip.value }) : forwarded;
  }

  if (request.merge === false) return ok({ outcome: 'left-ahead', head: tip.value });
  const worktree = await ensureActorWorktree(git, vault, accepted, actor, context.checks.reads);
  if (!worktree.ok) return worktree;
  const dirty = await hasTrackedChanges(git, worktree.value.path);
  if (!dirty.ok) return dirty;
  if (dirty.value) return ok({ outcome: 'uncommitted-changes', head: tip.value });
  const message = await addTrailers(git, worktree.value.path, `Sync ${actorBranch(actor)} with main at ${accepted.sha}`, packageTrailers(request.origin));
  if (!message.ok) return message;
  const merged = await mergeSha(git, worktree.value.path, accepted.sha, {
    message: message.value.trim(), date: request.date, ...(request.identity === undefined ? {} : { identity: request.identity }),
  });
  if (!merged.ok) {
    return merged.error.reason === 'conflict'
      ? err({ reason: 'sync-conflict', conflict: { actor, head: tip.value, accepted: accepted.sha, paths: merged.error.paths } })
      : merged;
  }

  const checked = await runChecks({ git, store: context.store, vault }, { commit: merged.value.head, actor }, context.checks);
  if (!checked.ok) return checked;
  const attribution = context.attribution ?? (request.identity === undefined ? {} : { identity: request.identity });
  const recorded = await recordCheckResults(git, vault.path, merged.value.head, checked.value.results, { ...attribution, date: context.clock.now() });
  if (!recorded.ok) return err({ reason: 'checks-not-recorded', sha: merged.value.head, cause: recorded.error });
  return ok({ outcome: 'merged', head: merged.value.head, checks: checked.value.results });
}

/** An actor's branch that cannot be synced: merging the accepted main into it conflicts in `paths`. */
export interface SyncConflict {
  readonly actor: string;
  /** The branch's head, and the accepted main it conflicts with. */
  readonly head: Sha;
  readonly accepted: Sha;
  readonly paths: readonly string[];
}

/**
 * Whether syncing `actor`'s branch with the accepted main would conflict, by a
 * trial merge: undefined when it would not (no branch, already up to date,
 * nothing of its own, or a clean merge). Nothing is touched.
 */
export async function syncConflict(
  git: Git, vault: RegisteredVault, accepted: AcceptedMain, actor: string,
): Promise<Result<SyncConflict | undefined, GitError>> {
  const tip = await resolveRevision(git, vault.path, `refs/heads/${actorBranch(actor)}`);
  if (!tip.ok) return tip.error.reason === 'unknown-revision' ? ok(undefined) : tip;
  for (const [ancestor, descendant] of [[accepted.sha, tip.value], [tip.value, accepted.sha]] as const) {
    const contained = await isAncestor(git, vault.path, ancestor, descendant);
    if (!contained.ok) return contained;
    if (contained.value) return ok(undefined); // up to date, or a fast-forward
  }
  const paths = await mergeConflicts(git, vault.path, tip.value, accepted.sha);
  if (!paths.ok) return paths;
  return ok(paths.value.length === 0 ? undefined : { actor, head: tip.value, accepted: accepted.sha, paths: paths.value });
}

/** What conflicts and how an owner resolves it: by hand in the actor's worktree, finished with `vault commit` (and `vault propose` in forge mode). */
export function conflictNotice(vault: RegisteredVault, conflict: SyncConflict, review: VaultIdentity['review']): string {
  const { actor } = conflict;
  const forge = review === 'forge';
  return [
    `${actorBranch(actor)} (at ${conflict.head}) conflicts with the accepted main (${conflict.accepted}) in: ${conflict.paths.join(', ')}.`,
    `Until it is resolved, its branch cannot be brought up to date, so its jobs stop out-of-date${forge ? ' and its pull request cannot merge' : ''}.`,
    `To resolve it, while no session holds ${actor}: in ${actorWorktreePath(vault, actor)}, run "git merge ${conflict.accepted}",`
      + ` resolve and stage those files, then run "vault commit ${vault.id} --actor ${actor}"${forge ? ` and "vault propose ${vault.id} ${actor}"` : ''}.`,
  ].join('\n');
}
