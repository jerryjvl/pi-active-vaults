// Writing history: commits with trailers, and merging a reviewed commit.
//
// Invariants:
//  - package commits are made as the identity and at the time the caller gives,
//    never silently as whoever the machine's Git config names;
//  - they run none of the repository's hooks and ask for no signature, so a
//    stray hook or signing prompt cannot block or alter an actor's commit;
//  - a merge takes a full SHA, never a name that could move between review and
//    accept; it refuses a tree with tracked changes, and a conflict is undone so
//    the repository is left as it was.

import { err, ok, type Result } from '../result/index.ts';
import { failure, runForSuccess, runForText, runGit, type Git, type GitError } from './exec.ts';
import type { Trailer } from './history.ts';
import { isAncestor, resolveRevision, type Sha } from './refs.ts';
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

/** Appends trailers to a message, replacing an existing trailer of the same key. */
export async function addTrailers(git: Git, message: string, trailers: readonly Trailer[]): Promise<Result<string, GitError>> {
  const args = ['interpret-trailers', '--if-exists', 'replace', '--if-missing', 'add'];
  for (const { key, value } of trailers) {
    const checked = checkTrailer(key, value);
    if (!checked.ok) return checked;
    args.push('--trailer', `${key}: ${value}`);
  }
  const ran = await runGit(git, args, { cwd: process.cwd(), input: message });
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(ran.value.stdout.toString('utf8')) : err(failure(args, ran.value));
}

/** True when tracked files differ from HEAD (staged or not); untracked files are not counted. */
export async function hasTrackedChanges(git: Git, repo: string): Promise<Result<boolean, GitError>> {
  const text = await runForText(git, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules'], { cwd: repo });
  return text.ok ? ok(text.value !== '') : text;
}

export async function createCommit(git: Git, repo: string, options: CommitOptions): Promise<Result<Sha, GitError>> {
  const env = attributionEnv(options);
  if (!env.ok) return env;
  const paths = options.stage === undefined || options.stage === 'all' ? undefined : options.stage;
  for (const path of paths ?? []) {
    const checked = checkTreePath(path);
    if (!checked.ok) return checked;
  }
  const pathspec = paths === undefined ? [] : ['--', ...paths];

  const staged = await runForSuccess(git, ['add', '--all', ...(paths === undefined ? ['--', '.'] : pathspec)], { cwd: repo });
  if (!staged.ok) return staged;

  if (options.allowEmpty !== true) {
    const diff = await runGit(git, ['diff', '--cached', '--quiet', ...pathspec], { cwd: repo });
    if (!diff.ok) return diff;
    if (diff.value.exitCode === 0) return err({ reason: 'nothing-to-commit' });
  }

  const message = options.trailers === undefined || options.trailers.length === 0
    ? ok(options.message)
    : await addTrailers(git, options.message, options.trailers);
  if (!message.ok) return message;

  const args = [
    '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--no-gpg-sign', '--quiet', '--cleanup=whitespace',
    ...(options.allowEmpty === true ? ['--allow-empty'] : []), '-F', '-', ...pathspec,
  ];
  const committed = await runGit(git, args, { cwd: repo, input: message.value, env: env.value });
  if (!committed.ok) return committed;
  if (committed.value.exitCode !== 0) return err(failure(args, committed.value));
  return resolveRevision(git, repo, 'HEAD');
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
