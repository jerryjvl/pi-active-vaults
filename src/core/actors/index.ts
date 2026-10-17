// Public surface of the actors module: actor branches and worktrees, the hold
// that keeps one writer per actor, proposals, review records, SHA-bound accept
// and adopt, and commit trailers.

export { TRAILER, isTaintedCommit, packageTrailers, trailerValue, type CommitOrigin } from './trailers.ts';
export {
  actorBranch,
  actorWorktreePath,
  commitAsActor,
  ensureActorWorktree,
  type ActorCommit,
  type ActorCommitError,
  type WorktreeError,
} from './worktrees.ts';
export { readProposal, type Proposal, type ProposalError } from './proposal.ts';
export { actorsSchema } from './schema.ts';
export { actorHold, listActorHolds, releaseActorHold, takeActorHold, type ActorHold, type HoldError, type Holder } from './holds.ts';
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
