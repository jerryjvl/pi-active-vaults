// What a repository says about itself: its config values, its remotes, and
// where a worktree's Git directory is — for `vault doctor`, which reports a
// hooks path that bypasses the package's hooks, a local vault with a remote,
// and locks left in main's worktree.

import { isAbsolute, resolve } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';
import { failure, runForText, runGit, type Git, type GitError } from './exec.ts';

/** A config key as git names it: section, optional subsection, name — never an option. */
const CONFIG_KEY = /^[A-Za-z][A-Za-z0-9-]*(\.[^\s]+)?\.[A-Za-z][A-Za-z0-9-]*$/;

/** The value of `key` as the repository sees it (all config levels), or undefined when unset. */
export async function configValue(git: Git, repo: string, key: string): Promise<Result<string | undefined, GitError>> {
  if (!CONFIG_KEY.test(key)) return err({ reason: 'invalid-argument', argument: 'key' });
  const args = ['config', '--get', key];
  const ran = await runGit(git, args, { cwd: repo });
  if (!ran.ok) return ran;
  if (ran.value.exitCode === 0) return ok(ran.value.stdout.toString('utf8').trim());
  return ran.value.exitCode === 1 ? ok(undefined) : err(failure(args, ran.value));
}

/** The names of the repository's remotes, sorted. */
export async function listRemotes(git: Git, repo: string): Promise<Result<string[], GitError>> {
  const text = await runForText(git, ['remote'], { cwd: repo });
  return text.ok ? ok(text.value === '' ? [] : text.value.split('\n').sort()) : text;
}

/** A worktree's own Git directory (its index, HEAD and their locks) and the repository's common one (hooks, refs). */
export async function gitDirectories(git: Git, worktree: string): Promise<Result<{ own: string; common: string }, GitError>> {
  const text = await runForText(git, ['rev-parse', '--git-dir', '--git-common-dir'], { cwd: worktree });
  if (!text.ok) return text;
  const [own = '', common = ''] = text.value.split('\n');
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(worktree, path));
  return ok({ own: absolute(own), common: absolute(common) });
}
