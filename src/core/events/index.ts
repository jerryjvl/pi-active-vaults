// Git events, derived from history (core.md "events").
//
// Events come from commits, never from a working tree, so nothing is lost
// while no daemon runs and an uncommitted edit triggers nothing. Both kinds
// follow first parents: on `main` each step — an accept's merge, an adopted
// commit — is one `merged` event carrying everything it brought; on an actor
// branch each commit is one `committed` event, and merges into the branch
// (bringing it up to date with `main`) are not the actor's work. Labels are
// read from the commit itself, or from before a deletion.
//
// Each change is attributed to the commit that made it, with that commit's
// actor and run from its trailers (concepts.md "Session tree"): within a
// merge, the last commit it brought that changed the path — a merge commit
// only when no other commit did, as when it resolved a conflict. So one
// merge can continue several runs' trees, and a rebased or amended commit
// keeps its run, since its message keeps the trailer.

import type { ChangedDocument, GitEvent } from '../conditions/index.ts';
import { TRAILER, trailerValue } from '../actors/index.ts';
import { isDocumentPath, labelsOf, readDocumentAt } from '../documents/index.ts';
import { changedPaths, commitsBetween, type CommitInfo, type Git, type GitError, type Sha } from '../git/index.ts';
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

type Attribution = Pick<ChangedDocument, 'commit' | 'actor' | 'trace'>;

function attributionOf(commit: CommitInfo): Attribution {
  const actor = trailerValue(commit, TRAILER.actor);
  const trace = trailerValue(commit, TRAILER.trace);
  return { commit: commit.sha, ...(actor === undefined ? {} : { actor }), ...(trace === undefined ? {} : { trace }) };
}

/** Which commit made each path's change in `commit`: itself, or for a merge, one of the commits it brought. */
async function madeBy(git: Git, repo: string, commit: CommitInfo): Promise<Result<(path: string) => CommitInfo, GitError>> {
  const [parent] = commit.parents;
  if (parent === undefined || commit.parents.length < 2) return ok(() => commit);
  const brought = await commitsBetween(git, repo, parent, commit.sha);
  if (!brought.ok) return brought;
  // Oldest first, so a later commit replaces an earlier one for the same path.
  const byCommit = new Map<string, CommitInfo>();
  const byMerge = new Map<string, CommitInfo>();
  for (const candidate of brought.value) {
    const changes = await changedPaths(git, repo, candidate.parents[0] ?? null, candidate.sha);
    if (!changes.ok) return changes;
    for (const change of changes.value) (candidate.parents.length < 2 ? byCommit : byMerge).set(change.path, candidate);
  }
  return ok((path) => byCommit.get(path) ?? byMerge.get(path) ?? commit);
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
    const attributed = await madeBy(git, repo, commit);
    if (!attributed.ok) return attributed;
    const changed: ChangedDocument[] = [];
    for (const change of changes.value) {
      const labels = await labelsAt(git, repo, change.change === 'deleted' && parent !== null ? parent : commit.sha, change.path);
      if (!labels.ok) return labels;
      changed.push({ ...change, labels: labels.value, ...attributionOf(attributed.value(change.path)) });
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
