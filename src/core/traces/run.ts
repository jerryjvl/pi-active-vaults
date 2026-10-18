// A run's compact record as its commits carry it (concepts.md "Trace"): the
// record is written into the actor's worktree just before each of the run's
// commits, so the commit includes it, and each names every document the run
// has produced so far — those its earlier commits on the branch made (found
// by their `Vault-Trace`) and those this commit makes. So the branch tip
// always holds the run's latest record, and a run that commits nothing leaves
// none in the vault: its full log and its spawn's state say how it ended.
//
// The record never makes a commit on its own: when nothing else would be
// committed, nothing is written and there is nothing to commit.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TRAILER, trailerValue } from '../actors/index.ts';
import { inPackageDirectory, isDocumentPath } from '../documents/index.ts';
import { changedPaths, commitsBetween, uncommittedPaths, type Git, type GitError, type Sha } from '../git/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { compactTracePath, writeCompactTrace, type CompactTrace } from './compact.ts';

/** Everything a compact record says but the documents, which come from the commits. */
export type RunRecord = Omit<CompactTrace, 'documents'>;

export type RunRecordError = GitError | { readonly reason: 'invalid-trace'; readonly issues: readonly Issue[] };

/** The paths the run's own commits since `since` changed, oldest first. */
async function earlierPaths(git: Git, worktree: string, since: Sha, trace: string): Promise<Result<string[], GitError>> {
  const commits = await commitsBetween(git, worktree, since, 'HEAD');
  if (!commits.ok) return commits;
  const paths: string[] = [];
  for (const commit of commits.value.filter((c) => trailerValue(c, TRAILER.trace) === trace)) {
    const changes = await changedPaths(git, worktree, commit.parents[0] ?? null, commit.sha);
    if (!changes.ok) return changes;
    paths.push(...changes.value.map((c) => c.path));
  }
  return ok(paths);
}

/** Whether `path` is one of `committing`, or below one of them. */
function isCommitted(path: string, committing: 'all' | readonly string[]): boolean {
  return committing === 'all' || committing.some((c) => path === c || path.startsWith(`${c.replace(/\/+$/, '')}/`));
}

/**
 * Writes the run's record into `worktree` for the commit about to be made of
 * `committing` (everything, or these paths), counting the documents that
 * still exist; returns the record's vault path, for the commit to include.
 */
export async function writeRunRecord(
  git: Git, worktree: string, since: Sha, record: RunRecord, committing: 'all' | readonly string[],
): Promise<Result<string, RunRecordError>> {
  const path = compactTracePath(record.trace);
  const changed = await uncommittedPaths(git, worktree);
  if (!changed.ok) return changed;
  const pending = changed.value.filter((p) => p !== path && isCommitted(p, committing));
  if (pending.length === 0) return err({ reason: 'nothing-to-commit' });
  const earlier = await earlierPaths(git, worktree, since, record.trace);
  if (!earlier.ok) return earlier;
  const documents = [...new Set([...earlier.value, ...pending])]
    .filter((p) => isDocumentPath(p) && !inPackageDirectory(p) && existsSync(join(worktree, ...p.split('/'))))
    .sort();
  const written = writeCompactTrace(worktree, { ...record, documents });
  return written.ok ? written : err({ reason: 'invalid-trace', issues: written.error });
}
