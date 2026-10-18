// Accepting a proposal (architecture.md "Review and accept", security.md): in
// `local` review mode, the owner act that moves `main`.
//
// It composes, in order: no unaccepted change on `main` (merging onto one
// would quietly accept it too); an owner of the accepted `main` approving; the
// commit that owner last reviewed — their own review, never anyone else's —
// being exactly the branch's tip (a branch that moved since review is refused); the approval recorded as an attestation; the merge
// policy satisfied for that commit; a merge of that SHA — never a branch name
// — into the checkout of `main`; and recording the merge as the accepted
// `main`, but only if `main` had not moved meanwhile. In `forge` mode the
// forge merges; a local accept is refused.

import { recordAttestation, type AttestationError } from '../attestations/index.ts';
import type { Clock } from '../clock/index.ts';
import { listWorktrees, mergeSha, resolveRevision, type Git, type GitError, type Identity, type Sha } from '../git/index.ts';
import {
  MAIN_BRANCH,
  UNCACHED_READS,
  acceptedIdentity,
  recordAccepted,
  requireNoUnacceptedChange,
  type AcceptedMain,
  type AcceptedReads,
  type UnacceptedChangeError,
} from '../integrity/index.ts';
import { evaluateMerge, type MergeEvaluation, type PolicyVerdict } from '../policy/index.ts';
import { isOwner, type IdentityError, type RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { readProposal } from './proposal.ts';
import { reviewRecord, type ReviewError } from './review.ts';
import { actorBranch } from './worktrees.ts';

export interface AcceptRequest {
  /** The person accepting; must be an owner. */
  readonly approver: string;
  /** Git identity for the approval note and the merge commit. */
  readonly identity?: Identity;
  /** The surface the approval came through, when not the owner's own (an MCP profile). */
  readonly via?: string;
}

export type AcceptError =
  | ReviewError
  | GitError
  | IdentityError
  | AttestationError
  | UnacceptedChangeError
  | { readonly reason: 'forge-mode' }
  | { readonly reason: 'not-owner'; readonly approver: string }
  | { readonly reason: 'not-reviewed'; readonly actor: string; readonly approver: string }
  | { readonly reason: 'branch-moved'; readonly reviewed: Sha; readonly head: Sha }
  | { readonly reason: 'policy-unmet'; readonly verdict: PolicyVerdict }
  | { readonly reason: 'main-not-checked-out' }
  | { readonly reason: 'main-moved' }
  | { readonly reason: 'accepted-moved'; readonly current: Sha | null };

export async function accept(
  context: { readonly git: Git; readonly store: Store; readonly clock: Clock; readonly reads?: AcceptedReads },
  vault: RegisteredVault,
  actor: string,
  request: AcceptRequest,
): Promise<Result<{ accepted: AcceptedMain; evaluation: MergeEvaluation }, AcceptError>> {
  const { git, store, clock } = context;
  const accepted = await requireNoUnacceptedChange(git, store, vault);
  if (!accepted.ok) return accepted;
  const identity = await acceptedIdentity(context.reads ?? UNCACHED_READS, git, vault.path, accepted.value);
  if (!identity.ok) return identity;
  if (identity.value.review === 'forge') return err({ reason: 'forge-mode' });
  if (!isOwner(identity.value, request.approver)) return err({ reason: 'not-owner', approver: request.approver });

  // Only the approver's own review binds the SHA: what someone else looked at
  // is not what this owner is approving.
  const reviewed = reviewRecord(store, vault.id, actor, request.approver);
  if (reviewed === undefined) return err({ reason: 'not-reviewed', actor, approver: request.approver });
  const proposal = await readProposal(git, vault.path, accepted.value, actor);
  if (!proposal.ok) return proposal;
  const { head, base, tainted } = proposal.value;
  if (head !== reviewed.sha) return err({ reason: 'branch-moved', reviewed: reviewed.sha, head });

  const attribution = { ...(request.identity === undefined ? {} : { identity: request.identity }), date: clock.now() };
  const approval = await recordAttestation(git, vault.path, {
    kind: 'approval',
    name: request.approver,
    subject: head,
    result: 'pass',
    by: request.via === undefined ? request.approver : `${request.approver} via ${request.via}`,
    at: clock.now().toISOString(),
  }, attribution);
  if (!approval.ok) return approval;

  const evaluation = await evaluateMerge(git, vault.path, { accepted: accepted.value, base, head, tainted, ...(context.reads === undefined ? {} : { reads: context.reads }) });
  if (!evaluation.ok) return evaluation;
  if (!evaluation.value.verdict.satisfied) return err({ reason: 'policy-unmet', verdict: evaluation.value.verdict });

  const worktrees = await listWorktrees(git, vault.path);
  if (!worktrees.ok) return worktrees;
  const mainCheckout = worktrees.value.find((w) => w.branch === MAIN_BRANCH);
  if (mainCheckout === undefined) return err({ reason: 'main-not-checked-out' });
  const merged = await mergeSha(git, mainCheckout.path, head, { ...attribution, message: `Accept ${actorBranch(actor)} at ${head}` });
  if (!merged.ok) return merged;

  // Something may have committed to main between the check above and the
  // merge; then the merge also carries that commit, so it is not recorded and
  // the change shows as unaccepted for an owner to look at.
  const parent = await resolveRevision(git, vault.path, `${merged.value.head}^1`);
  if (!parent.ok) return parent;
  if (parent.value !== accepted.value.sha) return err({ reason: 'main-moved' });

  const recorded = recordAccepted(store, vault.id, { sha: merged.value.head, how: 'accept', by: request.approver, at: clock.now() }, accepted.value.sha);
  return recorded.ok ? ok({ accepted: recorded.value, evaluation: evaluation.value }) : recorded;
}
