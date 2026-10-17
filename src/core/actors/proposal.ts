// Proposals (concepts.md "Actor"): an actor's branch ahead of the accepted
// `main`. Its changes are measured from where it branched off (the merge
// base), so work on `main` since then is not mistaken for the actor's; it is
// tainted when any of its commits is (see `trailers.ts`).

import {
  changedPaths,
  commitsBetween,
  mergeBase,
  resolveRevision,
  type CommitInfo,
  type FileChange,
  type Git,
  type GitError,
  type Sha,
} from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { isTaintedCommit } from './trailers.ts';
import { actorBranch } from './worktrees.ts';

export interface Proposal {
  readonly actor: string;
  readonly branch: string;
  /** The branch's tip: the commit a review records and an accept merges. */
  readonly head: Sha;
  /** Where it branched from the accepted main. */
  readonly base: Sha;
  /** Its commits the accepted main does not contain, oldest first. */
  readonly commits: readonly CommitInfo[];
  readonly changes: readonly FileChange[];
  readonly tainted: boolean;
}

export type ProposalError =
  | GitError
  | { readonly reason: 'no-proposal'; readonly actor: string }
  | { readonly reason: 'unrelated-history'; readonly actor: string };

export async function readProposal(git: Git, repo: string, accepted: AcceptedMain, actor: string): Promise<Result<Proposal, ProposalError>> {
  const branch = actorBranch(actor);
  const head = await resolveRevision(git, repo, `refs/heads/${branch}`);
  if (!head.ok) return head.error.reason === 'unknown-revision' ? err({ reason: 'no-proposal', actor }) : head;
  const commits = await commitsBetween(git, repo, accepted.sha, head.value);
  if (!commits.ok) return commits;
  if (commits.value.length === 0) return err({ reason: 'no-proposal', actor });
  const base = await mergeBase(git, repo, accepted.sha, head.value);
  if (!base.ok) return base;
  if (base.value === undefined) return err({ reason: 'unrelated-history', actor });
  const changes = await changedPaths(git, repo, base.value, head.value);
  if (!changes.ok) return changes;
  return ok({
    actor,
    branch,
    head: head.value,
    base: base.value,
    commits: commits.value,
    changes: changes.value,
    tainted: commits.value.some(isTaintedCommit),
  });
}
