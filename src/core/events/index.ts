// Git events, derived from history (core.md "events").
//
// Events come from commits, never from a working tree, so nothing is lost
// while no daemon runs and an uncommitted edit triggers nothing. Both kinds
// follow first parents: on `main` each step — an accept's merge, an adopted
// commit — is one `merged` event carrying everything it brought; on an actor
// branch each commit is one `committed` event, and merges into the branch
// (bringing it up to date with `main`) are not the actor's work. Labels are
// read from the commit itself, or from before a deletion.

import type { GitEvent } from '../conditions/index.ts';
import { TRAILER, trailerValue } from '../actors/index.ts';
import { isDocumentPath, labelsOf, readDocumentAt } from '../documents/index.ts';
import { changedPaths, commitsBetween, type Git, type GitError, type Sha } from '../git/index.ts';
import { ok, type Result } from '../result/index.ts';

export interface EventRange {
  readonly kind: GitEvent['kind'];
  /** Exclusive; null means from the first commit. */
  readonly from: Sha | null;
  readonly to: string;
}

async function labelsAt(git: Git, repo: string, revision: Sha, path: string): Promise<Result<string[], GitError>> {
  if (!isDocumentPath(path)) return ok([]);
  const read = await readDocumentAt(git, repo, revision, path);
  if (!read.ok) return read;
  // A document whose frontmatter cannot be read carries no labels: it then
  // matches fewer conditions, never more.
  return ok(read.value.state === 'read' ? labelsOf(read.value.document.frontmatter) : []);
}

/** The events of `vault` in `range`, oldest first. */
export async function deriveEvents(git: Git, repo: string, vault: string, range: EventRange): Promise<Result<GitEvent[], GitError>> {
  const commits = await commitsBetween(git, repo, range.from, range.to, { firstParent: true });
  if (!commits.ok) return commits;
  const events: GitEvent[] = [];
  for (const commit of commits.value) {
    if (range.kind === 'committed' && commit.parents.length > 1) continue;
    const parent = commit.parents[0] ?? null;
    const changes = await changedPaths(git, repo, parent, commit.sha);
    if (!changes.ok) return changes;
    const changed = [];
    for (const change of changes.value) {
      const labels = await labelsAt(git, repo, change.change === 'deleted' && parent !== null ? parent : commit.sha, change.path);
      if (!labels.ok) return labels;
      changed.push({ ...change, labels: labels.value });
    }
    const trace = trailerValue(commit, TRAILER.trace);
    const session = trailerValue(commit, TRAILER.session);
    events.push({
      kind: range.kind,
      vault,
      commit: commit.sha,
      changes: changed,
      ...(trace === undefined ? {} : { trace }),
      ...(session === undefined ? {} : { session }),
    });
  }
  return ok(events);
}
