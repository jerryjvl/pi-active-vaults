// Writing history: commits with trailers — prepared first, so blocking
// checks can assess one before it lands — and merging a reviewed commit.
//
// Invariants:
//  - package commits are made as the identity and at the time the caller gives,
//    never silently as whoever the machine's Git config names;
//  - they run none of the repository's hooks and ask for no signature, so a
//    stray hook or signing prompt cannot block or alter an actor's commit;
//  - a prepared commit is on no branch until it lands, and it lands only on
//    the branch it was prepared on, if that branch has not moved since;
//  - a merge takes a full SHA, never a name that could move between review and
//    accept; it refuses a tree with tracked changes, and a conflict is undone so
//    the repository is left as it was.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';
import { failure, runChecked, runForSuccess, runForText, runGit, type Git, type GitError } from './exec.ts';
import type { Trailer } from './history.ts';
import { isAncestor, resolveRevision, updateRef, type Sha } from './refs.ts';
import { checkIdentity, checkSha, checkTreePath, checkTrailer } from './validate.ts';

export interface Identity {
  readonly name: string;
  readonly email: string;
}

export interface Attribution {
  readonly identity?: Identity;
  /** The author and committer date; pass the injected clock's time. */
  readonly date?: Date;
}

export interface CommitOptions extends Attribution {
  readonly message: string;
  readonly trailers?: readonly Trailer[];
  /** What to stage: everything (default) or only these paths. */
  readonly stage?: 'all' | readonly string[];
  readonly allowEmpty?: boolean;
}

/** Environment that makes git record the given identity and date. */
export function attributionEnv(attribution: Attribution): Result<Record<string, string>, GitError> {
  const env: Record<string, string> = {};
  const { identity, date } = attribution;
  if (identity !== undefined) {
    const checked = checkIdentity(identity.name, identity.email);
    if (!checked.ok) return checked;
    Object.assign(env, {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
  }
  if (date !== undefined) {
    const raw = `${Math.floor(date.getTime() / 1000)} +0000`;
    Object.assign(env, { GIT_AUTHOR_DATE: raw, GIT_COMMITTER_DATE: raw });
  }
  return ok(env);
}

/**
 * Appends trailers to a message for a commit in `repo`, replacing an existing
 * trailer of the same key. Git runs inside `repo`, so the message is formatted
 * under that repository's trailer settings — the same ones `git commit` there
 * applies — and never under whatever repository the process happens to be in.
 */
export async function addTrailers(git: Git, repo: string, message: string, trailers: readonly Trailer[]): Promise<Result<string, GitError>> {
  const args = ['interpret-trailers', '--if-exists', 'replace', '--if-missing', 'add'];
  for (const { key, value } of trailers) {
    const checked = checkTrailer(key, value);
    if (!checked.ok) return checked;
    args.push('--trailer', `${key}: ${value}`);
  }
  const ran = await runChecked(git, args, { cwd: repo, input: message });
  return ran.ok ? ok(ran.value.stdout.toString('utf8')) : ran;
}

/** True when tracked files differ from HEAD (staged or not); untracked files are not counted. */
export async function hasTrackedChanges(git: Git, repo: string): Promise<Result<boolean, GitError>> {
  const text = await runForText(git, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules'], { cwd: repo });
  return text.ok ? ok(text.value !== '') : text;
}

/** Paths that differ from HEAD — staged, unstaged or untracked, ignored ones aside — sorted; renames as a deletion and a creation. */
export async function uncommittedPaths(git: Git, repo: string): Promise<Result<string[], GitError>> {
  const ran = await runChecked(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules', '--no-renames'], { cwd: repo });
  if (!ran.ok) return ran;
  // Each entry is two status letters, a space and the path; the letters may be spaces, so nothing is trimmed.
  const entries = ran.value.stdout.toString('utf8').split('\0').filter((entry) => entry !== '');
  return ok([...new Set(entries.map((entry) => entry.slice(3)))].sort());
}

/** The tracked changes from HEAD in the working tree, as a diff (no external diff or text conversion runs). */
export async function uncommittedDiff(git: Git, repo: string): Promise<Result<string, GitError>> {
  const ran = await runChecked(git, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--'], { cwd: repo });
  return ran.ok ? ok(ran.value.stdout.toString('utf8')) : ran;
}

/** Returns a worktree to its last commit: tracked changes undone, untracked files removed (ignored ones stay). */
export async function discardUncommitted(git: Git, repo: string): Promise<Result<void, GitError>> {
  const reset = await runForSuccess(git, ['reset', '--hard', '--quiet', 'HEAD'], { cwd: repo });
  if (!reset.ok) return reset;
  return runForSuccess(git, ['clean', '-d', '--force', '--quiet'], { cwd: repo });
}

/** A commit made but not yet on any branch: what a blocking check assesses before it lands. */
export interface PreparedCommit {
  readonly sha: Sha;
  /** The branch it is for, and the commit that branch held; null in a repository with no commits yet. */
  readonly ref: string;
  readonly parent: Sha | null;
  readonly stage: 'all' | readonly string[];
}

/** Runs `work` with a private index file, removed afterwards; the repository's own index is never touched. */
async function withScratchIndex<T>(work: (env: Record<string, string>) => Promise<Result<T, GitError>>): Promise<Result<T, GitError>> {
  const dir = mkdtempSync(join(tmpdir(), 'pav-index-'));
  try {
    return await work({ GIT_INDEX_FILE: join(dir, 'index') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Makes the commit `git commit` would make in `repo` — the same staging,
 * trailers, identity and time — without moving its branch, HEAD or index:
 * staging happens in a private index (starting from the repository's own
 * when everything is staged, from the parent when only some paths are).
 */
export async function prepareCommit(git: Git, repo: string, options: CommitOptions): Promise<Result<PreparedCommit, GitError>> {
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const stage = options.stage ?? 'all';
  for (const path of stage === 'all' ? [] : stage) {
    const checked = checkTreePath(path);
    if (!checked.ok) return checked;
  }
  const ref = await runGit(git, ['symbolic-ref', '--quiet', 'HEAD'], { cwd: repo });
  if (!ref.ok) return ref;
  if (ref.value.exitCode !== 0) return err({ reason: 'invalid-argument', argument: 'HEAD (detached)' });
  const head = await resolveRevision(git, repo, 'HEAD');
  if (!head.ok && head.error.reason !== 'unknown-revision') return head;
  const parent = head.ok ? head.value : null;

  const tree = await withScratchIndex(async (index) => {
    if (stage === 'all') {
      const own = await runForText(git, ['rev-parse', '--git-path', 'index'], { cwd: repo });
      if (!own.ok) return own;
      const ownIndex = resolve(repo, own.value);
      if (existsSync(ownIndex)) copyFileSync(ownIndex, index['GIT_INDEX_FILE'] ?? '');
    } else if (parent !== null) {
      const read = await runForSuccess(git, ['read-tree', parent], { cwd: repo, env: index });
      if (!read.ok) return read;
    }
    const staged = await runForSuccess(git, ['add', '--all', '--', ...(stage === 'all' ? ['.'] : stage)], { cwd: repo, env: index });
    if (!staged.ok) return staged;
    return runForText(git, ['write-tree'], { cwd: repo, env: index });
  });
  if (!tree.ok) return tree;
  if (options.allowEmpty !== true) {
    // The parent's tree, or the empty tree (in the repository's own object format).
    const before = parent === null
      ? await runForText(git, ['hash-object', '-t', 'tree', '--stdin'], { cwd: repo, input: '' })
      : await runForText(git, ['rev-parse', `${parent}^{tree}`], { cwd: repo });
    if (!before.ok) return before;
    if (before.value === tree.value) return err({ reason: 'nothing-to-commit' });
  }

  const withTrailers = options.trailers === undefined || options.trailers.length === 0
    ? ok(options.message)
    : await addTrailers(git, repo, options.message, options.trailers);
  if (!withTrailers.ok) return withTrailers;
  // As `git commit --cleanup=whitespace`: surrounding blank lines and trailing spaces go; lines starting with # stay.
  const message = await runChecked(git, ['stripspace'], { cwd: repo, input: withTrailers.value });
  if (!message.ok) return message;
  const args = ['-c', 'commit.gpgsign=false', 'commit-tree', '--no-gpg-sign', tree.value, ...(parent === null ? [] : ['-p', parent]), '-F', '-'];
  const sha = await runForText(git, args, { cwd: repo, input: message.value.stdout, env: env.value });
  if (!sha.ok) return sha;
  return ok({ sha: sha.value, ref: ref.value.stdout.toString('utf8').trim(), parent, stage });
}

/**
 * Moves the prepared commit's branch to it, only if the branch still holds
 * the commit it was prepared on, then brings the checkout's index up to it
 * for what was staged (the working tree is never touched).
 */
export async function landCommit(git: Git, repo: string, prepared: PreparedCommit): Promise<Result<Sha, GitError>> {
  const moved = await updateRef(git, repo, prepared.ref, prepared.sha, prepared.parent);
  if (!moved.ok) return moved;
  const synced = await runForSuccess(git, ['reset', '--quiet', ...(prepared.stage === 'all' ? [] : ['--', ...prepared.stage])], { cwd: repo });
  return synced.ok ? ok(prepared.sha) : synced;
}

/** Commits in `repo` on its checked-out branch: `prepareCommit`, then `landCommit`. */
export async function createCommit(git: Git, repo: string, options: CommitOptions): Promise<Result<Sha, GitError>> {
  const prepared = await prepareCommit(git, repo, options);
  return prepared.ok ? landCommit(git, repo, prepared.value) : prepared;
}

async function unmergedPaths(git: Git, repo: string): Promise<string[]> {
  const ran = await runGit(git, ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: repo });
  return ran.ok ? ran.value.stdout.toString('utf8').split('\0').filter((p) => p !== '') : [];
}

/**
 * Merges the commit `sha` into the checked-out branch with a merge commit.
 * Returns the new head, and whether anything changed (false when `sha` was
 * already part of the branch's history).
 */
export async function mergeSha(
  git: Git,
  repo: string,
  sha: Sha,
  options: Attribution & { message: string },
): Promise<Result<{ head: Sha; changed: boolean }, GitError>> {
  const checked = checkSha(sha);
  if (!checked.ok) return checked;
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const target = await resolveRevision(git, repo, sha);
  if (!target.ok) return target;

  const dirty = await hasTrackedChanges(git, repo);
  if (!dirty.ok) return dirty;
  if (dirty.value) return err({ reason: 'dirty-worktree' });

  const already = await isAncestor(git, repo, sha, 'HEAD');
  if (!already.ok) return already;
  if (already.value) {
    const head = await resolveRevision(git, repo, 'HEAD');
    return head.ok ? ok({ head: head.value, changed: false }) : head;
  }

  const args = ['merge', '--no-ff', '--no-verify', '--no-gpg-sign', '--no-verify-signatures', '--no-edit', '-m', options.message, sha];
  const merged = await runGit(git, args, { cwd: repo, env: env.value });
  if (!merged.ok) return merged;
  if (merged.value.exitCode !== 0) {
    const paths = await unmergedPaths(git, repo);
    await runGit(git, ['merge', '--abort'], { cwd: repo }); // leave the repository as it was
    return err(paths.length > 0 ? { reason: 'conflict', paths } : failure(args, merged.value));
  }
  const head = await resolveRevision(git, repo, 'HEAD');
  return head.ok ? ok({ head: head.value, changed: true }) : head;
}

/**
 * Stages `paths` as executable files, whatever the file system records: on a
 * platform without an execute bit (`core.fileMode` off) Git keeps the mode
 * given here when the files are committed.
 */
export async function stageExecutable(git: Git, repo: string, paths: readonly string[]): Promise<Result<void, GitError>> {
  for (const path of paths) {
    const checked = checkTreePath(path);
    if (!checked.ok) return checked;
  }
  if (paths.length === 0) return ok(undefined);
  const added = await runForSuccess(git, ['add', '--', ...paths], { cwd: repo });
  return added.ok ? runForSuccess(git, ['update-index', '--chmod=+x', '--', ...paths], { cwd: repo }) : added;
}

/** Moves the checked-out branch in `worktree` forward to `sha`, only if that is a fast-forward and the tree is clean. */
export async function fastForward(git: Git, worktree: string, sha: Sha): Promise<Result<void, GitError>> {
  const checked = checkSha(sha);
  if (!checked.ok) return checked;
  const dirty = await hasTrackedChanges(git, worktree);
  if (!dirty.ok) return dirty;
  if (dirty.value) return err({ reason: 'dirty-worktree' });
  return runForSuccess(git, ['merge', '--ff-only', '--quiet', '--no-verify', '--no-verify-signatures', sha], { cwd: worktree });
}
