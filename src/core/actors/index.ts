// Public surface of the actors module: actor branches and worktrees,
// proposals, review records, SHA-bound accept, and commit trailers.

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
export { actorsSchema, review, reviewRecord, type Review, type ReviewError, type ReviewRecord } from './review.ts';
export { accept, type AcceptError, type AcceptRequest } from './accept.ts';
