// Public surface of the actors module: actor branches and worktrees, the hold
// that keeps one writer per actor, proposals, review records, SHA-bound accept
// and adopt, and commit trailers.

export { TRAILER, isTaintedCommit, packageTrailers, trailerValue, type CommitOrigin } from './trailers.ts';
export {
  actorBranch,
  actorWorktreePath,
  commitAsActor,
  ensureActorWorktree,
  worktreeFile,
  type ActorCommit,
  type ActorCommitContext,
  type ActorCommitError,
  type ActorCommitted,
  type WorktreeError,
} from './worktrees.ts';
export { readProposal, type Proposal, type ProposalError } from './proposal.ts';
export { conflictNotice, syncActorBranch, syncConflict, type SyncConflict, type SyncError, type SyncOutcome, type SyncRequest } from './sync.ts';
export { resetActorBranch, type ResetContext, type ResetOutcome } from './reset.ts';
export { actorsSchema } from './schema.ts';
export { actorHold, heldByAnother, listActorHolds, releaseActorHold, takeActorHold, type ActorHold, type HoldError, type Holder, type StandingHold } from './holds.ts';
export { review, reviewRecord, type Review, type ReviewError, type ReviewRecord } from './review.ts';
export { accept, type AcceptError, type AcceptRequest } from './accept.ts';
export {
  adopt,
  adoptionDelta,
  type AdoptError,
  type AdoptRequest,
  type AdoptionConcerns,
  type AdoptionDelta,
  type AdoptionError,
} from './adopt.ts';
