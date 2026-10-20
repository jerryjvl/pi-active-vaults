// Merge results (security-setup.md): whether a proposal merged in the forge
// reached `main` with its commits. Attestations and trace notes are attached
// to the reviewed commits, so a squash or rebase merge — which replaces them —
// leaves them attached to nothing in `main`. Forge settings should forbid
// those methods; this is the check that holds whatever the settings were.
// What the check finds is reported until the actor's branch stops holding the
// approved head — reset by the package when that loses nothing (see
// `actors/reset.ts`), by the owner otherwise — and a branch that still holds
// it is not proposed again.
//
// Invariants:
//  - what merged is asked before `main` is fetched, so every merge the forge
//    names is in the `main` it is judged against: one made in between is
//    named on the next round instead of being misjudged;
//  - a merge is judged once: its result is recorded per vault and pull
//    request, and only newly recorded results are returned (so owners are
//    told once);
//  - a head that is missing here is not in `main`: fetching `main` brings
//    every commit it contains.

import { actorBranch, type ResetOutcome } from '../actors/index.ts';
import { isAncestor, listWorktrees, stepsIn, type Git } from '../git/index.ts';
import { MAIN_BRANCH, type AcceptedMain, type VaultLocation } from '../integrity/index.ts';
import { ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';
import type { PullRequest } from './adapter.ts';
import { judgedPulls, lostRows, recordMerge, type MergeResult } from './merged.ts';
import { connectForge, type ForgeDeps, type ForgeSyncError } from './sync.ts';

/** A proposal the forge says was merged: its pull request, the actor whose branch it was, and the head it was merged at. */
export interface MergedProposal {
  readonly pull: PullRequest;
  readonly actor: string;
}

/** The writers' proposals merged most recently in the forge and not judged yet. Asked before fetching `main`. */
export async function uncheckedMerges(deps: ForgeDeps, vault: VaultLocation, writers: readonly string[]): Promise<Result<MergedProposal[], ForgeSyncError>> {
  const adapter = await connectForge(deps, vault);
  if (!adapter.ok) return adapter;
  const merged = await adapter.value.mergedPullRequests(MAIN_BRANCH);
  if (!merged.ok) return merged;
  const judged = judgedPulls(deps.store, vault.id);
  const unchecked: MergedProposal[] = [];
  for (const pull of merged.value) {
    const actor = writers.find((w) => actorBranch(w) === pull.head);
    if (actor !== undefined && !judged.has(pull.number)) unchecked.push({ pull, actor });
  }
  return ok(unchecked);
}

/** Judges each merge against `accepted` — fetched after the merges were asked — and records it; returns the results recorded now. */
export async function checkMerges(deps: ForgeDeps, vault: VaultLocation, accepted: AcceptedMain, merges: readonly MergedProposal[]): Promise<Result<MergeResult[], ForgeSyncError>> {
  const recorded: MergeResult[] = [];
  for (const { pull, actor } of merges) {
    const contained = await isAncestor(deps.git, vault.path, pull.headSha, accepted.sha);
    if (!contained.ok && contained.error.reason !== 'unknown-revision') return contained;
    const result: MergeResult = {
      vault: vault.id, pull: pull.number, url: pull.url, actor, head: pull.headSha, main: accepted.sha, kept: contained.ok && contained.value, at: deps.clock.now().toISOString(),
    };
    if (recordMerge(deps.store, result)) recorded.push(result);
  }
  return ok(recorded);
}

/** A lost merge whose actor's branch still holds the approved head, and where that branch is checked out, if anywhere. */
export interface StandingMerge extends MergeResult {
  readonly checkout?: string;
}

/**
 * The vault's merged proposals whose commits did not reach `main` and whose
 * actor's branch still holds the approved head, newest pull request first. A
 * report clears itself when the branch no longer holds the head (or is gone),
 * so nothing needs dismissing. A branch that cannot be read counts as holding
 * it: a report is not dropped on a failure.
 */
export async function lostMerges(git: Git, store: Queryable, vault: VaultLocation): Promise<StandingMerge[]> {
  const standing: MergeResult[] = [];
  for (const r of lostRows(store, vault.id)) {
    const holds = await isAncestor(git, vault.path, r.head, `refs/heads/${actorBranch(r.actor)}`);
    if (holds.ok ? holds.value : holds.error.reason !== 'unknown-revision') standing.push(r);
  }
  if (standing.length === 0) return [];
  const worktrees = await listWorktrees(git, vault.path);
  return standing.map((r) => {
    const checkout = worktrees.ok ? worktrees.value.find((w) => w.branch === actorBranch(r.actor))?.path : undefined;
    return checkout === undefined ? r : { ...r, checkout };
  });
}

/** What a lost merge is, in one line. */
export function lostMergeText(r: MergeResult): string {
  return `Pull request #${r.pull} from ${r.actor} (${actorBranch(r.actor)}${r.url === '' ? '' : `, ${r.url}`}) was merged without its commits: its head ${r.head} is not in main (${r.main}), so its attestations and trace notes no longer attach.`;
}

/**
 * What ends it, for the owner to do when the package did not reset the branch:
 * the commands — in the worktree where the branch is checked out (seeing
 * first that nothing there is uncommitted), else in the vault's clone — and
 * when they may be run (the conditions of `resetActorBranch`).
 */
function lostMergeAdvice(r: MergeResult, vault: VaultLocation, checkout: string | undefined): string {
  const branch = actorBranch(r.actor);
  const steps = checkout === undefined
    ? stepsIn(vault.path, [`git branch -f ${branch} main`])
    : stepsIn(checkout, ['git status', 'git reset --hard main']);
  return `While the branch holds the head it is not proposed again. To end this, reset ${branch} to main once no session holds ${r.actor}`
    + `${checkout === undefined ? '' : ' and "git status" shows nothing uncommitted in its worktree'} — it discards everything the branch holds beyond main:\n${steps}`;
}

/** A lost merge as status and doctor show it: what happened, and what to do. */
export function lostMergeReport(r: StandingMerge, vault: VaultLocation): string {
  return `${lostMergeText(r)} ${lostMergeAdvice(r, vault, r.checkout)}`;
}

/** A lost merge as the owners are told it, with what became of its branch; `standing` is its listing if the branch still holds the head. */
export function lostMergeNotice(r: MergeResult, vault: VaultLocation, reset: ResetOutcome | undefined, standing: StandingMerge | undefined): string {
  if (reset?.outcome === 'reset') return `${lostMergeText(r)} ${actorBranch(r.actor)} held exactly the approved head, nobody held ${r.actor} and its worktree was clean, so it was reset to main.`;
  const why = reset === undefined ? 'it could not be reset' : whyNotReset(reset);
  return `${lostMergeText(r)} ${actorBranch(r.actor)} was left as it is: ${why}. ${lostMergeAdvice(r, vault, standing?.checkout)}`;
}

function whyNotReset(outcome: Exclude<ResetOutcome, { outcome: 'reset' }>): string {
  switch (outcome.outcome) {
    case 'no-branch': return 'it no longer exists';
    case 'moved': return `it has moved on from the approved head (now at ${outcome.head})`;
    case 'actor-busy': return `session ${outcome.hold.holder.session} holds ${outcome.hold.actor}`;
    case 'uncommitted-changes': return 'its worktree has uncommitted changes';
  }
}
