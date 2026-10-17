// Bringing an actor's branch up to date with the accepted `main` (cli.md
// `vault sync`): the accepted `main`, never `main`'s tip, since nothing may
// be built on content no owner accepted.
//
// A branch with no work of its own moves forward to it. A branch with work
// gets a merge commit in the actor's worktree, carrying the package's
// trailers — a commit without them counts as outside work, which taints a
// proposal — and, like any new head, assessed by every check on the accepted
// `main`, whose verdicts are recorded (the merge is already made; a failing
// check then stands against the proposal until it is fixed). Syncing writes
// as the actor: not while another session holds it, and never over
// uncommitted changes in its worktree.

import {
  addTrailers, fastForward, hasTrackedChanges, isAncestor, listWorktrees, mergeSha, resolveRevision, updateRef,
  type Identity, type Sha,
} from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { recordCheckResults, runChecks, type CheckResult } from '../scripts/index.ts';
import { actorHold, sameHolder, type Holder } from './holds.ts';
import { packageTrailers, type CommitOrigin } from './trailers.ts';
import { actorBranch, ensureActorWorktree, type ActorCommitContext, type ActorCommitError, type WorktreeError } from './worktrees.ts';

export interface SyncRequest {
  readonly origin: CommitOrigin;
  /** The injected clock's time, for a merge commit. */
  readonly date: Date;
  readonly identity?: Identity;
  /** The syncing session's own hold, when it has one. */
  readonly holder?: Holder;
}

export interface SyncOutcome {
  readonly outcome: 'no-branch' | 'up-to-date' | 'fast-forwarded' | 'merged' | 'uncommitted-changes';
  /** The branch's head afterwards. */
  readonly head?: Sha;
  /** For a merge: every check's verdict on it. */
  readonly checks?: readonly CheckResult[];
}

export type SyncError = ActorCommitError | WorktreeError;

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

  const hold = await actorHold(context.store, context.alive, vault.id, actor);
  if (hold !== undefined && (request.holder === undefined || !sameHolder(hold.holder, request.holder))) return err({ reason: 'actor-busy', hold });

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

  const worktree = await ensureActorWorktree(git, vault, accepted, actor);
  if (!worktree.ok) return worktree;
  const dirty = await hasTrackedChanges(git, worktree.value.path);
  if (!dirty.ok) return dirty;
  if (dirty.value) return ok({ outcome: 'uncommitted-changes', head: tip.value });
  const message = await addTrailers(git, worktree.value.path, `Sync ${actorBranch(actor)} with main at ${accepted.sha}`, packageTrailers(request.origin));
  if (!message.ok) return message;
  const merged = await mergeSha(git, worktree.value.path, accepted.sha, {
    message: message.value.trim(), date: request.date, ...(request.identity === undefined ? {} : { identity: request.identity }),
  });
  if (!merged.ok) return merged;

  const checked = await runChecks({ git, store: context.store, vault }, { commit: merged.value.head, actor }, context.checks);
  if (!checked.ok) return checked;
  const attribution = context.attribution ?? (request.identity === undefined ? {} : { identity: request.identity });
  const recorded = await recordCheckResults(git, vault.path, merged.value.head, checked.value.results, { ...attribution, date: context.clock.now() });
  if (!recorded.ok) return err({ reason: 'checks-not-recorded', sha: merged.value.head, cause: recorded.error });
  return ok({ outcome: 'merged', head: merged.value.head, checks: checked.value.results });
}
