// Actor branches and worktrees (concepts.md "Actor"): each actor writes on
// `actor/<name>` in `<worktrees>/<name>`, so work in progress never touches
// the vault's own checkout or `main`.
//
// A new actor branch starts at the accepted `main`, so an actor never builds on
// content no owner accepted. Commits are made only on the actor's own branch:
// a worktree on any other branch — `main` above all — is refused rather than
// written to.

import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensurePrivateDir } from '../config/index.ts';
import { addWorktree, createCommit, currentBranch, listWorktrees, resolveRevision, type Git, type GitError, type Identity, type Sha } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { isActor, readVaultIdentity, type IdentityError, type RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
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

export interface ActorCommit {
  readonly origin: CommitOrigin;
  readonly message: string;
  /** The injected clock's time. */
  readonly date: Date;
  readonly identity?: Identity;
  /** Everything (default) or only these paths. */
  readonly stage?: 'all' | readonly string[];
}

export type ActorCommitError = GitError | { readonly reason: 'wrong-branch'; readonly expected: string; readonly actual?: string };

/** Commits in `worktree` as `origin.actor`, with the package's trailers — only on that actor's branch. */
export async function commitAsActor(git: Git, worktree: string, commit: ActorCommit): Promise<Result<Sha, ActorCommitError>> {
  const expected = actorBranch(commit.origin.actor);
  const branch = await currentBranch(git, worktree);
  if (!branch.ok) return branch;
  if (branch.value !== expected) return err({ reason: 'wrong-branch', expected, ...(branch.value === undefined ? {} : { actual: branch.value }) });
  return createCommit(git, worktree, {
    message: commit.message,
    trailers: packageTrailers(commit.origin),
    date: commit.date,
    ...(commit.identity === undefined ? {} : { identity: commit.identity }),
    ...(commit.stage === undefined ? {} : { stage: commit.stage }),
  });
}
