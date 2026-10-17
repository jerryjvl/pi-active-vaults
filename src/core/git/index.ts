// Public surface of the git module: the only wrapper around the `git` command
// line. Functions take a `Git` (binary and environment, from `createGit`) first
// and the repository directory second, and return results as values.

export { createGit, redactUrlCredentials, type Git, type GitError, type GitOptions } from './exec.ts';
export {
  MINIMUM_GIT_VERSION,
  currentBranch,
  deleteRef,
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
  changedPaths,
  commitsBetween,
  diffText,
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
  hasTrackedChanges,
  mergeSha,
  type Attribution,
  type CommitOptions,
  type Identity,
} from './write.ts';
export { addWorktree, listWorktrees, removeWorktree, type AddWorktreeOptions, type Worktree } from './worktrees.ts';
export { notesAdd, notesAppend, notesList, notesRemove, notesShow, type NoteWriteOptions } from './notes.ts';
