// Actor branches and worktrees (concepts.md "Actor"): each actor writes on
// `actor/<name>` in `<worktrees>/<name>`, so work in progress never touches
// the vault's own checkout or `main`.
//
// A new actor branch starts at the accepted `main`, so an actor never builds on
// content no owner accepted. Commits are made only on the actor's own branch:
// a worktree on any other branch — `main` above all — is refused rather than
// written to. And only by its one writer: while a hold by another session
// stands, a commit is refused. A commit checks the hold and never takes one —
// sessions and the scheduler take holds; a command committing once need not.
//
// Checks block (extension.md "Commits"): the commit is prepared on no branch,
// every check on the accepted `main` assesses it, and it lands only if all
// pass; then their verdicts are recorded as attestations about it. A commit
// whose checks cannot run — `main` has an unaccepted change — is not made.

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ensurePrivateDir } from '../config/index.ts';
import type { AttestationError } from '../attestations/index.ts';
import type { Clock } from '../clock/index.ts';
import {
  addWorktree, currentBranch, landCommit, listWorktrees, prepareCommit, resolveRevision,
  type Attribution, type Git, type GitError, type Identity, type Sha,
} from '../git/index.ts';
import type { AcceptedMain, VaultLocation } from '../integrity/index.ts';
import type { ProcessLiveness } from '../process/index.ts';
import { isActor, readVaultIdentity, type IdentityError, type RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { recordCheckResults, runChecks, type CheckResult, type CheckRunOptions, type ScriptRunError } from '../scripts/index.ts';
import type { Queryable } from '../store/index.ts';
import { heldByAnother, type Holder, type HoldError } from './holds.ts';
import { packageTrailers, type CommitOrigin } from './trailers.ts';

export function actorBranch(actor: string): string {
  return `actor/${actor}`;
}

export function actorWorktreePath(vault: RegisteredVault, actor: string): string {
  return join(vault.worktrees, actor);
}

/** The same directory, seen through any symbolic links (git reports resolved paths). */
function samePath(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return real(a) === real(b);
}

export type WorktreeError =
  | GitError
  | IdentityError
  | { readonly reason: 'unknown-actor'; readonly actor: string }
  | { readonly reason: 'worktree-mismatch'; readonly path: string; readonly branch?: string };

/** The actor's worktree, made if missing: on its branch, which is created at the accepted main if it does not exist. */
export async function ensureActorWorktree(
  git: Git, vault: RegisteredVault, accepted: AcceptedMain, actor: string,
): Promise<Result<{ path: string; branch: string; created: boolean }, WorktreeError>> {
  const identity = await readVaultIdentity(git, vault.path, accepted.sha);
  if (!identity.ok) return identity;
  if (!isActor(identity.value, actor)) return err({ reason: 'unknown-actor', actor });

  const branch = actorBranch(actor);
  const path = actorWorktreePath(vault, actor);
  const worktrees = await listWorktrees(git, vault.path);
  if (!worktrees.ok) return worktrees;
  const existing = worktrees.value.find((w) => samePath(w.path, path));
  if (existing !== undefined) {
    if (existing.branch !== branch) return err({ reason: 'worktree-mismatch', path, ...(existing.branch === undefined ? {} : { branch: existing.branch }) });
    return ok({ path, branch, created: false });
  }

  const tip = await resolveRevision(git, vault.path, `refs/heads/${branch}`);
  if (!tip.ok && tip.error.reason !== 'unknown-revision') return tip;
  ensurePrivateDir(vault.worktrees);
  const added = await addWorktree(git, vault.path, path, tip.ok ? { branch } : { branch, createFrom: accepted.sha });
  return added.ok ? ok({ path, branch, created: true }) : added;
}

/**
 * The file `path` names in `root`, when the write stays inside it and out of
 * its Git internals — judged by where it really lands, since a directory on
 * the way may be a link to elsewhere — with its directories made; undefined
 * otherwise, with nothing made.
 */
export function worktreeFile(root: string, path: string): string | undefined {
  const parts = path.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (/^([\\/]|[A-Za-z]:)/.test(path) || parts.includes('..') || parts.length === 0 || parts[0]?.toLowerCase() === '.git') return undefined;
  const target = join(root, ...parts);
  let existing = dirname(target);
  while (!existsSync(existing)) existing = dirname(existing);
  const landed = relative(realpathSync.native(root), realpathSync.native(existing));
  if (landed.startsWith('..') || landed.split(sep)[0]?.toLowerCase() === '.git') return undefined;
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return undefined;
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

export interface ActorCommit {
  readonly origin: CommitOrigin;
  readonly message: string;
  /** The injected clock's time. */
  readonly date: Date;
  readonly identity?: Identity;
  /** Everything (default) or only these paths. */
  readonly stage?: 'all' | readonly string[];
  /** The committing session's own hold on the actor, when it has one. */
  readonly holder?: Holder;
}

export interface ActorCommitContext {
  readonly git: Git;
  readonly store: Queryable;
  readonly alive: ProcessLiveness;
  readonly clock: Clock;
  /** How the checks run. */
  readonly checks: CheckRunOptions;
  /** Who the check attestations are recorded as; the commit's identity when absent. */
  readonly attribution?: Attribution;
}

export interface ActorCommitted {
  readonly sha: Sha;
  /** Every check's verdict on it, all passing. */
  readonly checks: readonly CheckResult[];
}

export type ActorCommitError =
  | GitError
  | HoldError
  | ScriptRunError
  | { readonly reason: 'wrong-branch'; readonly expected: string; readonly actual?: string }
  /** Not made: these are every check's verdicts, not all of them passing. */
  | { readonly reason: 'checks-failed'; readonly results: readonly CheckResult[] }
  /** Made, but its passing verdicts could not be recorded; it needs its checks again. */
  | { readonly reason: 'checks-not-recorded'; readonly sha: Sha; readonly cause: AttestationError };

/**
 * Commits in `worktree` as `origin.actor` of `vault`, with the package's
 * trailers — only on that actor's branch, not while another holds it, and only
 * when every check on the accepted main passes it.
 */
export async function commitAsActor(context: ActorCommitContext, vault: VaultLocation, worktree: string, commit: ActorCommit): Promise<Result<ActorCommitted, ActorCommitError>> {
  const { git } = context;
  const { actor } = commit.origin;
  const expected = actorBranch(actor);
  const branch = await currentBranch(git, worktree);
  if (!branch.ok) return branch;
  if (branch.value !== expected) return err({ reason: 'wrong-branch', expected, ...(branch.value === undefined ? {} : { actual: branch.value }) });
  const hold = await heldByAnother(context.store, context.alive, vault.id, actor, commit.holder);
  if (hold !== undefined) return err({ reason: 'actor-busy', hold });

  const prepared = await prepareCommit(git, worktree, {
    message: commit.message,
    trailers: packageTrailers(commit.origin),
    date: commit.date,
    ...(commit.identity === undefined ? {} : { identity: commit.identity }),
    ...(commit.stage === undefined ? {} : { stage: commit.stage }),
  });
  if (!prepared.ok) return prepared;
  const checked = await runChecks({ git, store: context.store, vault }, { commit: prepared.value.sha, actor }, context.checks);
  if (!checked.ok) return checked;
  if (!checked.value.passed) return err({ reason: 'checks-failed', results: checked.value.results });
  const landed = await landCommit(git, worktree, prepared.value);
  if (!landed.ok) return landed;

  const attribution = context.attribution ?? (commit.identity === undefined ? {} : { identity: commit.identity });
  const recorded = await recordCheckResults(git, vault.path, landed.value, checked.value.results, { ...attribution, date: context.clock.now() });
  if (!recorded.ok) return err({ reason: 'checks-not-recorded', sha: landed.value, cause: recorded.error });
  return ok({ sha: landed.value, checks: checked.value.results });
}
