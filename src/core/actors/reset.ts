// Ending a proposal that merged without its commits (daemon.md "Forge sync"):
// after a squash or rebase merge the actor's branch still holds the commits
// `main` does not contain, so it stays a proposal. It is reset to the
// accepted `main`, never to `main`'s tip, but only when that discards nothing
// anyone could still be using.
//
// Invariants: the branch moves only when all hold — its tip is exactly the
// head that was approved, no session holds the actor, and its worktree has no
// change at all, untracked files included (`reset --hard` would overwrite
// one the new `main` contains). Each refusal is an outcome that names the
// condition, never a partial reset; a branch with no worktree moves by
// compare-and-swap on the head, so a commit made meanwhile is not lost.

import { listWorktrees, resetHard, resolveRevision, uncommittedPaths, updateRef, type GitError, type Sha } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { ok, type Result } from '../result/index.ts';
import { heldByAnother, type ActorHold } from './holds.ts';
import { actorBranch, type ActorCommitContext } from './worktrees.ts';

export type ResetOutcome =
  | { readonly outcome: 'reset'; readonly head: Sha }
  | { readonly outcome: 'no-branch' }
  /** The tip is not the approved head: work was added after it. */
  | { readonly outcome: 'moved'; readonly head: Sha }
  | { readonly outcome: 'actor-busy'; readonly hold: ActorHold }
  | { readonly outcome: 'uncommitted-changes'; readonly head: Sha };

/** Resets the actor's branch to `accepted` if it holds exactly `approvedHead`, nobody holds the actor and its worktree is clean; otherwise says why not. */
export async function resetActorBranch(
  context: Pick<ActorCommitContext, 'git' | 'store' | 'alive'>, vault: RegisteredVault, accepted: AcceptedMain, actor: string, approvedHead: Sha,
): Promise<Result<ResetOutcome, GitError>> {
  const { git } = context;
  const ref = `refs/heads/${actorBranch(actor)}`;
  const tip = await resolveRevision(git, vault.path, ref);
  if (!tip.ok) return tip.error.reason === 'unknown-revision' ? ok({ outcome: 'no-branch' }) : tip;
  if (tip.value !== approvedHead) return ok({ outcome: 'moved', head: tip.value });
  const hold = await heldByAnother(context.store, context.alive, vault.id, actor, undefined);
  if (hold !== undefined) return ok({ outcome: 'actor-busy', hold });

  const worktrees = await listWorktrees(git, vault.path);
  if (!worktrees.ok) return worktrees;
  const checkout = worktrees.value.find((w) => w.branch === actorBranch(actor));
  if (checkout === undefined) {
    const moved = await updateRef(git, vault.path, ref, accepted.sha, tip.value);
    return moved.ok ? ok({ outcome: 'reset', head: accepted.sha }) : moved;
  }
  const changed = await uncommittedPaths(git, checkout.path);
  if (!changed.ok) return changed;
  if (changed.value.length > 0) return ok({ outcome: 'uncommitted-changes', head: tip.value });
  const reset = await resetHard(git, checkout.path, accepted.sha);
  return reset.ok ? ok({ outcome: 'reset', head: accepted.sha }) : reset;
}
