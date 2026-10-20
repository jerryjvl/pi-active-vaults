// Running the `git` command line — the one place git is started (through
// `process`, like every process).
//
// Invariants:
//  - arguments are passed as an array, never through a shell;
//  - every run is bounded: past its time limit git is stopped, and output past
//    the limit is an error rather than a silently shortened result;
//  - the caller's ambient Git state (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …)
//    is removed, because the daemon may be started from a hook that sets them
//    and they would silently redirect an operation to another repository;
//  - git never prompts or opens an editor or pager, and messages are in the C
//    locale so the few places that classify a failure by its text are stable;
//  - repository-configured helper programs that run on read-only commands
//    (the file-system monitor) are switched off;
//  - failure details are bounded and have URL credentials redacted.

import { statSync } from 'node:fs';
import { runProcess } from '../process/index.ts';
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
  /** A merge in progress still has these paths unresolved: nothing is committed until they are. */
  | { readonly reason: 'unresolved-conflicts'; readonly paths: readonly string[] }
  /** A merge in progress is committed whole, never some of its paths. */
  | { readonly reason: 'merge-in-progress' }
  | { readonly reason: 'timed-out'; readonly command: string }
  | { readonly reason: 'output-too-large'; readonly command: string }
  | { readonly reason: 'git-failed'; readonly command: string; readonly exitCode: number | null; readonly stderr: string };

export interface Git {
  readonly binary: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface GitOptions {
  /** The environment to run under; defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** The git executable; defaults to `git` on the PATH. */
  readonly binary?: string;
  /** Time limit for one git command; default 10 minutes. */
  readonly timeoutMs?: number;
  /** Standard output one git command may produce; default 256 MiB. */
  readonly maxOutputBytes?: number;
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
const MAX_STDERR_BYTES = 64 * 1024;
// Generous: local commands finish in moments, and fetches and pushes to a
// forge should not be cut short; the limit is there so nothing waits forever.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// Large enough for any document or tree listing a vault plausibly holds.
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export function createGit(options: GitOptions = {}): Git {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const name of AMBIENT_GIT_VARIABLES) delete env[name];
  return {
    binary: options.binary ?? 'git',
    env: { ...env, ...NON_INTERACTIVE_ENV },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };
}

/** Removes `user:password@` from URLs in text that git (or a remote) printed. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, '$1');
}

/**
 * Runs git; the result is an error value only when git could not be started,
 * ran past its time limit, or printed more than the limit — otherwise the exit
 * status is the caller's to judge.
 */
export async function runGit(git: Git, args: readonly string[], options: RunOptions): Promise<Result<Outcome, GitError>> {
  try {
    if (!statSync(options.cwd).isDirectory()) return err({ reason: 'not-a-repository' });
  } catch {
    return err({ reason: 'not-a-repository' });
  }
  const ran = await runProcess({
    program: { file: git.binary, args: [...FIXED_ARGUMENTS, ...args] },
    cwd: options.cwd,
    env: { ...git.env, ...options.env },
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs: git.timeoutMs,
    maxStdoutBytes: git.maxOutputBytes,
    maxStderrBytes: MAX_STDERR_BYTES,
  });
  if (!ran.ok) return err({ reason: 'git-unavailable' });
  const command = args[0] ?? '';
  if (ran.value.timedOut) return err({ reason: 'timed-out', command });
  if (ran.value.stdoutTruncated) return err({ reason: 'output-too-large', command });
  return ok({ exitCode: ran.value.exitCode, stdout: ran.value.stdout, stderr: ran.value.stderr.toString('utf8') });
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

/** Runs git where only exit status 0 is success; any other exit is the matching failure. */
export async function runChecked(git: Git, args: readonly string[], options: RunOptions): Promise<Result<Outcome, GitError>> {
  const ran = await runGit(git, args, options);
  if (!ran.ok) return ran;
  return ran.value.exitCode === 0 ? ran : err(failure(args, ran.value));
}

/** Like `runChecked`, returning trimmed standard output. */
export async function runForText(git: Git, args: readonly string[], options: RunOptions): Promise<Result<string, GitError>> {
  const ran = await runChecked(git, args, options);
  return ran.ok ? ok(ran.value.stdout.toString('utf8').trim()) : ran;
}

/** Like `runChecked`, for commands whose output is not needed. */
export async function runForSuccess(git: Git, args: readonly string[], options: RunOptions): Promise<Result<void, GitError>> {
  const ran = await runChecked(git, args, options);
  return ran.ok ? ok(undefined) : ran;
}

/** Whether a command line's program is git — by name, or a path to it — as a guard reading commands must tell. */
export function isGitProgram(program: string): boolean {
  const base = program.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return base === 'git' || base === 'git.exe';
}
