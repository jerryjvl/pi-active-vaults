// Running a script: the one place the package starts a vault's own code.
//
// A run is a propagating action, so it composes, in order: no unaccepted
// change (`requireNoUnacceptedChange`), resolution from the accepted `main`,
// then execution with the script's declared limits. The script's directory is
// copied out of the accepted commit into a fresh private directory, so the
// working tree's version of the script or its support files can never run;
// the copy is removed afterwards.
//
// Limits: standard input is closed (scripts never prompt); the environment is
// exactly what the caller passes (nothing ambient, so no secret leaks in by
// accident); output and run time are bounded, and a run past its time is
// killed with everything it started; `net: no` is enforced where the platform
// can, and the outcome says whether it was.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PlatformKind } from '../config/index.ts';
import { TREE_MODES, gitExecPath, listTree, readFileAt, type Git, type GitError, type Sha } from '../git/index.ts';
import { requireNoUnacceptedChange, type UnacceptedChangeError, type VaultLocation } from '../integrity/index.ts';
import { runProcess } from '../process/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';
import { interpreterCommand, restrictNetwork, sandboxProbe, windowsShellCandidates, type Command, type NetworkSandbox } from './command.ts';
import { SCRIPT_DIRECTORIES, resolveScript, type ResolveOptions, type ScriptError, type ScriptOutput } from './resolve.ts';

export interface ScriptRunOptions extends ResolveOptions {
  /** The directory the script works in (an actor worktree, or the vault). */
  readonly cwd: string;
  /** The script's whole environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Standard output kept; more is cut off. Default 1 MiB. */
  readonly maxOutputBytes?: number;
  /** The platform the command line is built for. */
  readonly os: PlatformKind;
  /** From `probeNetworkSandbox`. */
  readonly sandbox: NetworkSandbox;
  /** Git for Windows' `sh`, from `findWindowsShell`. */
  readonly windowsShell?: string;
}

export interface ScriptOutcome extends ScriptOutput {
  readonly timedOut: boolean;
  readonly truncated: boolean;
  /** Whether network access was withdrawn (only ever for `net: no`). */
  readonly network: 'blocked' | 'unrestricted';
}

export type ScriptRunError = ScriptError | UnacceptedChangeError | { readonly reason: 'cannot-run'; readonly detail: string };

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Runs a command with no input, bounded output and a time limit; a timed-out run is killed with its process group. */
async function runBounded(
  command: Command, options: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number; maxOutputBytes: number },
): Promise<Result<Omit<ScriptOutcome, 'network'>, { reason: 'cannot-run'; detail: string }>> {
  const ran = await runProcess({
    program: { file: command.command, args: command.args },
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxOutputBytes,
    maxStderrBytes: MAX_STDERR_BYTES,
  });
  if (!ran.ok) return err({ reason: 'cannot-run', detail: ran.error.code });
  const { exitCode, stdout, stderr, timedOut, stdoutTruncated } = ran.value;
  return ok({ exitCode, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, truncated: stdoutTruncated });
}

/** Copies `directory` as committed in `sha` into a new private directory; links are not copied. */
async function materialise(git: Git, repo: string, sha: Sha, directory: string): Promise<Result<string, GitError>> {
  const entries = await listTree(git, repo, sha, directory);
  if (!entries.ok) return entries;
  const root = mkdtempSync(join(tmpdir(), 'pav-script-'));
  for (const entry of entries.value) {
    if (entry.mode === TREE_MODES.symlink) continue;
    const bytes = await readFileAt(git, repo, sha, entry.path);
    if (!bytes.ok) {
      rmSync(root, { recursive: true, force: true });
      return bytes;
    }
    const target = join(root, ...entry.path.split('/'));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes.value, { mode: 0o600 });
    if (entry.mode === TREE_MODES.executable) chmodSync(target, 0o700);
  }
  return ok(root);
}

export async function runScript(
  context: { readonly git: Git; readonly store: Queryable; readonly vault: VaultLocation },
  name: string,
  args: readonly string[],
  options: ScriptRunOptions,
): Promise<Result<ScriptOutcome, ScriptRunError>> {
  const { git, store, vault } = context;
  const accepted = await requireNoUnacceptedChange(git, store, vault);
  if (!accepted.ok) return accepted;
  const resolved = await resolveScript(git, vault.path, accepted.value, name, options);
  if (!resolved.ok) return resolved;

  if (resolved.value.source === 'builtin') {
    const output = await resolved.value.builtin.run(args, { cwd: options.cwd, env: options.env });
    return ok({ ...output, timedOut: false, truncated: false, network: 'unrestricted' });
  }

  const script = resolved.value;
  const root = await materialise(git, vault.path, accepted.value.sha, SCRIPT_DIRECTORIES[script.kind]);
  if (!root.ok) return root;
  try {
    const file = join(root.value, ...script.path.split('/'));
    const command = interpreterCommand(script.header.interpreter, file, args, {
      os: options.os,
      ...(options.windowsShell === undefined ? {} : { windowsShell: options.windowsShell }),
    });
    if (!command.ok) return err({ reason: 'cannot-run', detail: command.error });
    const limited = script.header.net ? { command: command.value, network: 'unrestricted' as const } : restrictNetwork(command.value, options.sandbox);
    const ran = await runBounded(limited.command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });
    return ran.ok ? ok({ ...ran.value, network: limited.network }) : ran;
  } finally {
    rmSync(root.value, { recursive: true, force: true });
  }
}

/** Which network isolation works on this machine: tried once with a harmless command; `none` if it fails. */
export async function probeNetworkSandbox(os: PlatformKind, env: Readonly<Record<string, string | undefined>>): Promise<NetworkSandbox> {
  const probe = sandboxProbe(os, process.execPath);
  if (probe === undefined) return 'none';
  const definedEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
  const ran = await runBounded(probe.command, { cwd: tmpdir(), env: definedEnv, timeoutMs: 5000, maxOutputBytes: 1024 });
  return ran.ok && ran.value.exitCode === 0 ? probe.sandbox : 'none';
}

/** Git for Windows' `sh`, found beside the git in use; undefined when there is none. */
export async function findWindowsShell(git: Git): Promise<string | undefined> {
  const execPath = await gitExecPath(git);
  return execPath.ok ? windowsShellCandidates(execPath.value).find((candidate) => existsSync(candidate)) : undefined;
}
