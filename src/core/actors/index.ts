// Public surface of the actors module: actor branches and worktrees,
// proposals, review records, SHA-bound accept, and commit trailers.

export { TRAILER, isTaintedCommit, packageTrailers, trailerValue, type CommitOrigin } from './trailers.ts';
