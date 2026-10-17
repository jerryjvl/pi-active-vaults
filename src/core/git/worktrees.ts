// Worktrees: each actor writes in its own checkout on its own branch, so work in
// progress never touches the vault's main checkout.

import { isAbsolute } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';
import { runChecked, runForSuccess, type Git, type GitError } from './exec.ts';
import type { Sha } from './refs.ts';
import { checkBranchName, checkSha } from './validate.ts';

export interface Worktree {
  readonly path: string;
  readonly head?: Sha;
  /** Short branch name; absent when detached. */
  readonly branch?: string;
}

export interface AddWorktreeOptions {
  readonly branch: string;
  /** Create the branch at this commit; omit to check out an existing branch. */
  readonly createFrom?: Sha;
}

export async function addWorktree(git: Git, repo: string, dir: string, options: AddWorktreeOptions): Promise<Result<void, GitError>> {
  const branch = checkBranchName(options.branch);
  if (!branch.ok) return branch;
  if (!isAbsolute(dir)) return err({ reason: 'invalid-argument', argument: 'directory' });
  if (options.createFrom === undefined) return runForSuccess(git, ['worktree', 'add', '--', dir, options.branch], { cwd: repo });
  const start = checkSha(options.createFrom);
  if (!start.ok) return start;
  return runForSuccess(git, ['worktree', 'add', '-b', options.branch, '--', dir, options.createFrom], { cwd: repo });
}

/** Removes a worktree; one with uncommitted changes is refused unless `force`. */
export function removeWorktree(git: Git, repo: string, dir: string, options: { force?: boolean }): Promise<Result<void, GitError>> {
  if (!isAbsolute(dir)) return Promise.resolve(err({ reason: 'invalid-argument', argument: 'directory' }));
  return runForSuccess(git, ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), '--', dir], { cwd: repo });
}

export async function listWorktrees(git: Git, repo: string): Promise<Result<Worktree[], GitError>> {
  const args = ['worktree', 'list', '--porcelain', '-z'];
  const ran = await runChecked(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  // Records are NUL-separated attribute lines, with an empty field between records.
  const worktrees: Worktree[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      worktrees.push({
        path: current.path,
        ...(current.head === undefined ? {} : { head: current.head }),
        ...(current.branch === undefined ? {} : { branch: current.branch }),
      });
    }
    current = {};
  };
  for (const field of ran.value.stdout.toString('utf8').split('\0')) {
    if (field === '') flush();
    else if (field.startsWith('worktree ')) current.path = field.slice('worktree '.length);
    else if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length);
  }
  flush();
  return ok(worktrees);
}
