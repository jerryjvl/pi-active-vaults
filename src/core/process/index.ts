// Starting processes — the one place the package does. Git, secret commands
// and scripts all run through `runProcess`, so how a process is started,
// bounded and stopped is decided once.
//
// Invariants:
//  - a program gets an argument array and never passes through a shell; a
//    shell runs only when the caller asks for one with a whole command line;
//  - the environment is exactly the one given — nothing is inherited, so a
//    secret in the caller's environment reaches a child only on purpose;
//  - standard input is closed unless input is given, so nothing can wait on a
//    prompt;
//  - output is bounded per stream, and cutting it off is reported;
//  - every run has a time limit. Past it, the process is killed — on POSIX
//    with its whole process group, since it leads one, so what it started dies
//    too — and the run ends without waiting for its output pipes, which a
//    surviving grandchild could hold open (on Windows only the process itself
//    is killed).

import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../result/index.ts';

/** A program with its arguments, or a command line for the platform's shell (`sh`, or `cmd.exe`). */
export type Program =
  | { readonly file: string; readonly args: readonly string[] }
  | { readonly shell: string };

export interface ProcessRequest {
  readonly program: Program;
  /** Defaults to the current directory. */
  readonly cwd?: string;
  /** The process's whole environment; unset values are left out. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Standard input; when absent, standard input is closed. */
  readonly input?: string | Uint8Array;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

export interface ProcessOutcome {
  /** null when the process was killed (time limit) or ended by a signal. */
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export type ProcessError = { readonly reason: 'cannot-start'; readonly code: string };

/** Whether a process is started as the leader of its own process group, so it can be killed with what it started. */
export function ownProcessGroup(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function bounded(limit: number): { push(chunk: Buffer): void; bytes(): Buffer; truncated(): boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  return {
    push(chunk) {
      const room = limit - size;
      if (chunk.length > room) cut = true;
      if (room > 0) {
        const kept = chunk.subarray(0, room);
        chunks.push(kept);
        size += kept.length;
      }
    },
    bytes: () => Buffer.concat(chunks),
    truncated: () => cut,
  };
}

function definedEntries(env: ProcessRequest['env']): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Runs one process to completion; an error value only when it could not be started at all. */
export function runProcess(request: ProcessRequest): Promise<Result<ProcessOutcome, ProcessError>> {
  return new Promise((resolve) => {
    const group = ownProcessGroup(process.platform);
    const { program } = request;
    const options = {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: definedEntries(request.env),
      stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] as ['ignore' | 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: group,
    };
    const child = 'shell' in program
      ? spawn(program.shell, { ...options, shell: true })
      : spawn(program.file, [...program.args], options);
    const { stdout: out, stderr: errOut } = child;
    if (out === null || errOut === null) throw new Error('standard output and error are always pipes');

    const stdout = bounded(request.maxStdoutBytes);
    const stderr = bounded(request.maxStderrBytes);
    let timedOut = false;
    let settled = false;
    const settle = (result: Result<ProcessOutcome, ProcessError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const outcome = (exitCode: number | null): Result<ProcessOutcome, ProcessError> => ok({
      exitCode: timedOut ? null : exitCode,
      stdout: stdout.bytes(),
      stderr: stderr.bytes(),
      timedOut,
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone; the process itself is killed below either way.
      }
      child.kill('SIGKILL');
      out.destroy();
      errOut.destroy();
    }, request.timeoutMs);

    out.on('data', (chunk: Buffer) => stdout.push(chunk));
    errOut.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => settle(err({ reason: 'cannot-start', code: error.code ?? 'UNKNOWN' })));
    // Normally the run ends once the output is complete ('close'); after a
    // time-out, as soon as the process has exited.
    child.on('exit', (code) => {
      if (timedOut) settle(outcome(code));
    });
    child.on('close', (code) => settle(outcome(code)));

    if (child.stdin !== null) {
      // A process that exits before reading its input closes the pipe; that is not a failure to start.
      child.stdin.on('error', () => {});
      child.stdin.end(request.input);
    }
  });
}
