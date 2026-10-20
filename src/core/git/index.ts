// Public surface of the git module: the only wrapper around the `git` command
// line. Functions take a `Git` (binary and environment, from `createGit`) first
// and the repository directory second, and return results as values.

export { createGit, isGitProgram, redactUrlCredentials, type Git, type GitError, type GitOptions } from './exec.ts';
export {
  MINIMUM_GIT_VERSION,
  currentBranch,
  deleteRef,
  gitExecPath,
  gitVersion,
  initRepository,
  isAncestor,
  listRefs,
  mergeBase,
  meetsMinimumGitVersion,
  repositoryRoot,
  resolveRevision,
  updateRef,
  type Sha,
} from './refs.ts';
export {
  TREE_MODES,
  changedPaths,
  commitsBetween,
  commitsWithTrailer,
  diffText,
  lastAdded,
  listFiles,
  listTree,
  pathTypeAt,
  readFileAt,
  readTextAt,
  type CommitInfo,
  type FileChange,
  type RangeOptions,
  type TreeEntry,
  type Trailer,
} from './history.ts';
export {
  addTrailers,
  createCommit,
  discardUncommitted,
  fastForward,
  hasTrackedChanges,
  landCommit,
  mergeConflicts,
  mergeSha,
  prepareCommit,
  resetHard,
  stageExecutable,
  uncommittedDiff,
  uncommittedPaths,
  type Attribution,
  type CommitOptions,
  type Identity,
  type PreparedCommit,
} from './write.ts';
export { isSha } from './validate.ts';
export { addWorktree, exportTree, listWorktrees, removeWorktree, type AddWorktreeOptions, type Worktree } from './worktrees.ts';
export { appendNoteLine, notesAdd, notesAppend, notesList, notesMergeLines, notesRemove, notesShow, type NoteWriteOptions } from './notes.ts';
export { checkRemote, fetchCommit, fetchRefs, pushRefs, remoteRef, remoteUrl, type Lease } from './remote.ts';
export { configValue, gitDirectories, listRemotes } from './config.ts';
