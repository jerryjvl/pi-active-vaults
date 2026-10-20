// Unaccepted changes: whenever the tip of `main` differs from the accepted
// `main` — new commits, a reset, a rewrite, a deleted `main`, or a vault no
// owner has accepted yet — the vault has an unaccepted change (security.md).
//
// Every propagating action (trigger, spawn, script run, index update, push)
// asks `requireNoUnacceptedChange` first and refuses if there is one; every
// surface shows `unacceptedNotice` until an owner adopts the change or resets
// `main`. Reading, review and interactive work continue meanwhile, against the
// accepted `main`.

import { commitsBetween, isAncestor, resolveRevision, stepsIn, type CommitInfo, type Git, type GitError, type Sha } from '../git/index.ts';
import type { ReviewMode } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';
import { acceptedMain, type AcceptedMain } from './accepted.ts';

/** The vault's `main` branch: the only branch owners accept into. */
export const MAIN_BRANCH = 'main';
export const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;

export interface VaultLocation {
  readonly id: string;
  readonly path: string;
  /** The Git remote the vault's forge (forge mode) or backup (local mode) is on, by its name in this clone. */
  readonly remote?: string;
}

export type UnacceptedKind = 'none-accepted' | 'ahead' | 'behind' | 'diverged' | 'main-missing';

export interface UnacceptedChange {
  readonly state: 'unaccepted';
  readonly vault: string;
  /** The vault's clone, where `main` is mended by hand. */
  readonly path: string;
  readonly change: UnacceptedKind;
  /** `main`'s tip, or null when `main` is missing. */
  readonly tip: Sha | null;
  readonly accepted?: AcceptedMain;
  /** Commits on `main` that the accepted main does not contain (none for a reset). */
  readonly commits: readonly CommitInfo[];
}

export type IntegrityStatus = { readonly state: 'accepted'; readonly accepted: AcceptedMain } | UnacceptedChange;

/** The tip of `main`, or null when there is no `main`. */
export async function mainTip(git: Git, repo: string): Promise<Result<Sha | null, GitError>> {
  const tip = await resolveRevision(git, repo, MAIN_REF);
  if (tip.ok) return tip;
  return tip.error.reason === 'unknown-revision' ? ok(null) : tip;
}

/** How `tip` relates to `accepted`; a recorded commit that no longer exists counts as rewritten history. */
async function relation(git: Git, repo: string, accepted: Sha, tip: Sha): Promise<Result<'ahead' | 'behind' | 'diverged', GitError>> {
  for (const [ancestor, descendant, answer] of [[accepted, tip, 'ahead'], [tip, accepted, 'behind']] as const) {
    const is = await isAncestor(git, repo, ancestor, descendant);
    if (!is.ok) return is.error.reason === 'unknown-revision' ? ok('diverged') : is;
    if (is.value) return ok(answer);
  }
  return ok('diverged');
}

export async function integrityStatus(git: Git, store: Queryable, vault: VaultLocation): Promise<Result<IntegrityStatus, GitError>> {
  const accepted = acceptedMain(store, vault.id);
  const tip = await mainTip(git, vault.path);
  if (!tip.ok) return tip;
  const unaccepted = (change: UnacceptedKind, commits: readonly CommitInfo[] = []): Result<IntegrityStatus, GitError> =>
    ok({ state: 'unaccepted', vault: vault.id, path: vault.path, change, tip: tip.value, ...(accepted === undefined ? {} : { accepted }), commits });

  if (tip.value === null) return unaccepted('main-missing');
  if (accepted === undefined) return unaccepted('none-accepted');
  if (tip.value === accepted.sha) return ok({ state: 'accepted', accepted });
  const related = await relation(git, vault.path, accepted.sha, tip.value);
  if (!related.ok) return related;
  if (related.value === 'behind') return unaccepted('behind');
  const commits = await commitsBetween(git, vault.path, accepted.sha, tip.value);
  // A rewrite may have left the recorded commit unreachable or gone; the
  // change is still reported, without its commit list.
  return unaccepted(related.value, commits.ok ? commits.value : []);
}

export type UnacceptedChangeError = { readonly reason: 'unaccepted-change'; readonly status: UnacceptedChange };

/** The accepted main, if and only if `main` is at it: the guard every propagating action passes first. */
export async function requireNoUnacceptedChange(
  git: Git, store: Queryable, vault: VaultLocation,
): Promise<Result<AcceptedMain, GitError | UnacceptedChangeError>> {
  const status = await integrityStatus(git, store, vault);
  if (!status.ok) return status;
  return status.value.state === 'accepted' ? ok(status.value.accepted) : err({ reason: 'unaccepted-change', status: status.value });
}

/** The notice every surface shows for an unaccepted change: the vault, the commit, and the commands that resolve it, in the vault's clone. */
export function unacceptedNotice(status: UnacceptedChange, mode: ReviewMode): string {
  const accepted = status.accepted?.sha;
  const what =
    status.change === 'main-missing' ? 'main is missing'
    : status.change === 'none-accepted' ? `main (${status.tip}) has not been accepted by an owner yet`
    : status.change === 'behind' ? `main was reset to ${status.tip}, behind the accepted main`
    : status.change === 'diverged' ? `main's history was rewritten; it is now at ${status.tip}`
    : `main has ${status.commits.length} unaccepted commit(s), up to ${status.tip}`;
  const { tip, path } = status;
  const lines = [`Vault "${status.vault}": ${what}. Automation is paused for this vault.`];
  if (tip !== null && accepted !== undefined && (status.change === 'ahead' || status.change === 'diverged')) {
    lines.push(`What it is, in the vault's clone:\n${stepsIn(path, [`git log --oneline ${accepted}..${tip}`])}`);
  }
  // A forge-mode vault is accepted on the forge, never from a clone: syncing takes the forge's main as accepted.
  if (mode === 'forge') lines.push(`If the forge's main has it (merged there), "vault sync ${status.vault}" makes it the accepted main; the daemon does so each minute.`);
  else if (tip !== null) lines.push(`To accept it, an owner runs "vault accept ${status.vault} --adopt ${tip}".`);
  if (accepted !== undefined && tip === null) {
    lines.push(`To recreate main at the accepted main:\n${stepsIn(path, [`git branch main ${accepted}`])}`);
  } else if (accepted !== undefined && tip !== null) {
    // `--keep` moves main without losing uncommitted work, refusing if it would; the copy keeps commits main loses.
    const keep = status.change === 'behind' ? [] : [`git branch unaccepted-${tip.slice(0, 7)} ${tip}`];
    lines.push(`${mode === 'forge' ? 'If it is only in this clone' : 'Otherwise'}, put main back at the accepted main${keep.length > 0 ? ', keeping a copy of what it drops' : ''}:\n`
      + stepsIn(path, ['git switch main', ...keep, `git reset --keep ${accepted}`]));
  }
  return lines.join('\n');
}
