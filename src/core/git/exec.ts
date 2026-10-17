// Running the `git` command line — the one place a process is spawned for Git.
//
// Invariants:
//  - arguments are passed as an array, never through a shell;
//  - the caller's ambient Git state (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …)
//    is removed, because the daemon may be started from a hook that sets them
//    and they would silently redirect an operation to another repository;
//  - git never prompts or opens an editor or pager, and messages are in the C
//    locale so the few places that classify a failure by its text are stable;
//  - repository-configured helper programs that run on read-only commands
//    (the file-system monitor) are switched off;
//  - failure details are bounded and have URL credentials redacted.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { err, ok, type Result } from '../result/index.ts';

export type GitError =
  | { readonly reason: 'git-unavailable' }
  | { readonly reason: 'not-a-repository' }
  | { readonly reason: 'invalid-argument'; readonly argument: string }
  | { readonly reason: 'unknown-revision'; readonly revision: string }
  | { readonly reason: 'not-found'; readonly path: string }
  | { readonly reason: 'ref-moved'; readonly ref: string }
  | { readonly reason: 'dirty-worktree' }
  | { readonly reason: 'nothing-to-commit' }
  | { readonly reason: 'conflict'; readonly paths: readonly string[] }
  | { readonly reason: 'git-failed'; readonly command: string; readonly exitCode: number | null; readonly stderr: string };

export interface Git {
  readonly binary: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface GitOptions {
  /** The environment to run under; defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** The git executable; defaults to `git` on the PATH. */
  readonly binary?: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly input?: string | Uint8Array;
  /** Extra environment (identity, dates); wins over everything else. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface Outcome {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

const AMBIENT_GIT_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  GIT_OPTIONAL_LOCKS: '0',
  // Paths are file names, never globs or pathspec magic such as `:(top)`.
  GIT_LITERAL_PATHSPECS: '1',
  LC_ALL: 'C',
  LANGUAGE: 'C',
};
const FIXED_ARGUMENTS = ['-c', 'core.fsmonitor=false'];
const MAX_STDERR_CHARS = 2000;

export function createGit(options: GitOptions = {}): Git {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const name of AMBIENT_GIT_VARIABLES) delete env[name];
  return { binary: options.binary ?? 'git', env: { ...env, ...NON_INTERACTIVE_ENV } };
}

/** Removes `user:password@` from URLs in text that git (or a remote) printed. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1');
}

/** Runs git; the result is an error value only when git could not be started at all. */
export function runGit(git: Git, args: readonly string[], options: RunOptions): Promise<Result<Outcome, GitError>> {
  try {
    if (!statSync(options.cwd).isDirectory()) return Promise.resolve(err({ reason: 'not-a-repository' }));
  } catch {
    return Promise.resolve(err({ reason: 'not-a-repository' }));
  }
  return new Promise((resolve) => {
    const child = spawn(git.binary, [...FIXED_ARGUMENTS, ...args], {
      cwd: options.cwd,
      env: { ...git.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const errText: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errText.push(chunk));
    child.on('error', () => resolve(err({ reason: 'git-unavailable' })));
    child.on('close', (exitCode) =>
      resolve(ok({ exitCode, stdout: Buffer.concat(out), stderr: Buffer.concat(errText).toString('utf8') })),
    );
    // A command that exits before reading its input closes the pipe; that is not our failure.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

/** Turns an unexpected non-zero exit into the matching error value. */
export function failure(args: readonly string[], outcome: Outcome): GitError {
  if (/not a git repository/i.test(outcome.stderr)) return { reason: 'not-a-repository' };
  return {
    reason: 'git-failed',
    command: args[0] ?? '',
    exitCode: outcome.exitCode,
    stderr: redactUrlCredentials(outcome.stderr).slice(0, MAX_STDERR_CHARS).trim(),
  };
}

/** Runs git and returns trimmed standard output on success, or the failure. */
export async function runForText(git: Git, args: readonly string[], options: RunOptions): Promise<Result<string, GitError>> {
  const ran = await runGit(git, args, options);
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(ran.value.stdout.toString('utf8').trim()) : err(failure(args, ran.value));
}

/** Runs git where success is exit status 0 and the output is not needed. */
export async function runForSuccess(git: Git, args: readonly string[], options: RunOptions): Promise<Result<void, GitError>> {
  const ran = await runGit(git, args, options);
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ok(undefined) : err(failure(args, ran.value));
}
