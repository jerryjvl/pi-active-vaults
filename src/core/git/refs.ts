// Repositories, revisions and refs.

import { err, ok, type Result } from '../result/index.ts';
import { failure, runForSuccess, runForText, runGit, type Git, type GitError } from './exec.ts';
import { checkRefName, checkRefPrefix, checkRevision, checkSha } from './validate.ts';

export type Sha = string;

/** Git releases older than this lack options the package relies on (`worktree list -z`, `merge --no-verify`). */
export const MINIMUM_GIT_VERSION = [2, 36] as const;

export async function gitVersion(git: Git): Promise<Result<string, GitError>> {
  const text = await runForText(git, ['--version'], { cwd: process.cwd() });
  if (!text.ok) return text;
  const match = /(\d+\.\d+(?:\.\d+)*)/.exec(text.value);
  return match?.[1] === undefined ? err({ reason: 'git-failed', command: '--version', exitCode: 0, stderr: '' }) : ok(match[1]);
}

export function meetsMinimumGitVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [wantMajor, wantMinor] = MINIMUM_GIT_VERSION;
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

export function initRepository(git: Git, path: string, options: { initialBranch?: string }): Promise<Result<void, GitError>> {
  const branch = options.initialBranch;
  return runForSuccess(git, ['init', '--quiet', ...(branch === undefined ? [] : ['--initial-branch', branch]), '--', path], { cwd: process.cwd() });
}

/** The top-level directory of the repository containing `directory`. */
export function repositoryRoot(git: Git, directory: string): Promise<Result<string, GitError>> {
  return runForText(git, ['rev-parse', '--show-toplevel'], { cwd: directory });
}

/** Resolves a revision to the commit it names; the SHA is what callers should record and compare. */
export async function resolveRevision(git: Git, repo: string, revision: string): Promise<Result<Sha, GitError>> {
  const checked = checkRevision(revision);
  if (!checked.ok) return checked;
  const args = ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(ran.value.stdout.toString('utf8').trim());
  // --quiet turns "no such revision" into a silent exit 1; anything else is a real failure.
  return err(ran.value.exitCode === 1 && ran.value.stderr === '' ? { reason: 'unknown-revision', revision } : failure(args, ran.value));
}

/** The checked-out branch, or undefined when HEAD is detached. */
export async function currentBranch(git: Git, repo: string): Promise<Result<string | undefined, GitError>> {
  const args = ['symbolic-ref', '--quiet', '--short', 'HEAD'];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(ran.value.stdout.toString('utf8').trim());
  return ran.value.exitCode === 1 ? ok(undefined) : err(failure(args, ran.value));
}

const REF_CONFLICT = /cannot lock ref|reference already exists|unable to resolve reference|is at .* but expected/i;

async function updateRefChecked(git: Git, repo: string, args: string[], ref: string): Promise<Result<void, GitError>> {
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(undefined);
  return err(REF_CONFLICT.test(ran.value.stderr) ? { reason: 'ref-moved', ref } : failure(args, ran.value));
}

/**
 * Compare-and-swap: sets `ref` to `newSha` only if it currently holds
 * `expectedOld` (`null` meaning it must not exist yet). Losing the race is
 * `ref-moved`, so a caller that reviewed one state cannot overwrite another.
 */
export async function updateRef(git: Git, repo: string, ref: string, newSha: Sha, expectedOld: Sha | null): Promise<Result<void, GitError>> {
  const checkedRef = checkRefName(ref);
  if (!checkedRef.ok) return checkedRef;
  const checkedNew = checkSha(newSha);
  if (!checkedNew.ok) return checkedNew;
  if (expectedOld !== null) {
    const checkedOld = checkSha(expectedOld);
    if (!checkedOld.ok) return checkedOld;
  }
  return updateRefChecked(git, repo, ['update-ref', ref, newSha, expectedOld ?? ''], ref);
}

export async function deleteRef(git: Git, repo: string, ref: string, expectedOld: Sha): Promise<Result<void, GitError>> {
  const checkedRef = checkRefName(ref);
  if (!checkedRef.ok) return checkedRef;
  const checkedOld = checkSha(expectedOld);
  if (!checkedOld.ok) return checkedOld;
  return updateRefChecked(git, repo, ['update-ref', '-d', ref, expectedOld], ref);
}

export async function listRefs(git: Git, repo: string, prefix: string): Promise<Result<{ ref: string; sha: Sha }[], GitError>> {
  const checked = checkRefPrefix(prefix);
  if (!checked.ok) return checked;
  const text = await runForText(git, ['for-each-ref', '--format=%(objectname) %(refname)', prefix], { cwd: repo });
  if (!text.ok) return text;
  return ok(
    text.value === ''
      ? []
      : text.value.split('\n').map((line) => {
          const [sha = '', ref = ''] = line.split(' ');
          return { ref, sha };
        }),
  );
}

/** Whether `ancestor` is part of `descendant`'s history — false after a reset or rewrite. */
export async function isAncestor(git: Git, repo: string, ancestor: string, descendant: string): Promise<Result<boolean, GitError>> {
  const a = await resolveRevision(git, repo, ancestor);
  if (!a.ok) return a;
  const d = await resolveRevision(git, repo, descendant);
  if (!d.ok) return d;
  const args = ['merge-base', '--is-ancestor', a.value, d.value];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(true);
  return ran.value.exitCode === 1 ? ok(false) : err(failure(args, ran.value));
}
