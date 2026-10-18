// Long-lived processes: what the daemon runs headless sessions as (`pi --mode
// rpc`), talking JSON lines over standard input and output. Started the same
// way as `runProcess` — an argument array, never a shell; exactly the
// environment given; its own process group on POSIX — but kept running, fed
// lines, and read line by line until it exits.
//
// Invariants:
//  - output lines are split on line feeds only (a trailing carriage return
//    dropped), never on other Unicode separators, which may appear inside a
//    JSON string (Pi's RPC framing);
//  - a line longer than the limit is dropped rather than held, and standard
//    error is kept only up to its limit, so a misbehaving child cannot
//    exhaust memory;
//  - killing ends the whole process group on POSIX, so what the child
//    started ends with it (on Windows only the child itself);
//  - a recorded process is ended only after its start time is checked to be
//    the one recorded (`endProcess`), so an ID the system has given to
//    another process is never touched — and never by name.

import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../result/index.ts';
import { processStartTime, type ProcessLiveness } from './identity.ts';
import { ownProcessGroup, type ProcessError, type ProcessRequest } from './run.ts';

export interface ChildRequest {
  readonly program: { readonly file: string; readonly args: readonly string[] };
  readonly cwd?: string;
  readonly env: ProcessRequest['env'];
  /** Longest output line kept (default 16 MiB). */
  readonly maxLineBytes?: number;
  /** Standard error kept (default 64 KiB). */
  readonly maxStderrBytes?: number;
}

export interface Child {
  readonly pid: number;
  /** Writes to its standard input; false once that is closed. */
  write(text: string): boolean;
  /** Closes its standard input: how an RPC session is asked to finish. */
  endInput(): void;
  /** Calls `listener` with each output line, from now on. */
  onLine(listener: (line: string) => void): void;
  /** What it wrote to standard error, up to the limit. */
  stderr(): string;
  /** Kills it, with its process group on POSIX. */
  kill(): void;
  readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
}

const DEFAULT_MAX_LINE = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 64 * 1024;

function definedEntries(env: ChildRequest['env']): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** Splits a byte stream into lines on LF only, dropping a trailing CR and lines over `max` bytes. */
function lineSplitter(max: number, emit: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let pending: Buffer[] = [];
  let size = 0;
  let overlong = false;
  const flush = (last: Buffer): void => {
    if (!overlong) {
      let line = Buffer.concat([...pending, last]);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      emit(line.toString('utf8'));
    }
    pending = [];
    size = 0;
    overlong = false;
  };
  return {
    push(chunk) {
      let start = 0;
      for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
        flush(chunk.subarray(start, at));
        start = at + 1;
      }
      const rest = chunk.subarray(start);
      if (rest.length === 0) return;
      size += rest.length;
      if (size > max) {
        overlong = true;
        pending = [];
      } else {
        pending.push(rest);
      }
    },
    end() {
      if (size > 0 || pending.length > 0) flush(Buffer.alloc(0));
    },
  };
}

/** Starts a long-lived child; an error value when it cannot be started at all. */
export function startChild(request: ChildRequest): Promise<Result<Child, ProcessError>> {
  return new Promise((resolve) => {
    const group = ownProcessGroup(process.platform);
    const child = spawn(request.program.file, [...request.program.args], {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: definedEntries(request.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: group,
    });
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) throw new Error('a child\'s standard streams are always pipes');
    stdin.on('error', () => {}); // a child that exits closes the pipe; writing then fails quietly

    const listeners: ((line: string) => void)[] = [];
    const lines = lineSplitter(request.maxLineBytes ?? DEFAULT_MAX_LINE, (line) => { for (const l of listeners) l(line); });
    stdout.on('data', (chunk: Buffer) => lines.push(chunk));
    stdout.on('end', () => lines.end());
    const maxStderr = request.maxStderrBytes ?? DEFAULT_MAX_STDERR;
    let errors = Buffer.alloc(0);
    stderr.on('data', (chunk: Buffer) => {
      if (errors.length < maxStderr) errors = Buffer.concat([errors, chunk]).subarray(0, maxStderr);
    });

    const exited = new Promise<{ exitCode: number | null; signal: string | null }>((done) => {
      child.on('close', (exitCode, signal) => done({ exitCode, signal }));
    });
    const kill = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is gone already; the child itself is killed below either way.
      }
      child.kill('SIGKILL');
    };

    child.on('error', (error: NodeJS.ErrnoException) => resolve(err({ reason: 'cannot-start', code: error.code ?? 'UNKNOWN' })));
    child.on('spawn', () => {
      const pid = child.pid;
      if (pid === undefined) throw new Error('a spawned child has a process ID');
      resolve(ok({
        pid,
        write: (text) => !stdin.destroyed && stdin.writable && stdin.write(text),
        endInput: () => stdin.end(),
        onLine: (listener) => { listeners.push(listener); },
        stderr: () => errors.toString('utf8'),
        kill,
        exited,
      }));
    });
  });
}

/** What became of a recorded process asked to end. */
export type EndOutcome = 'ended' | 'gone' | 'not-that-process' | 'cannot-tell';

/**
 * Ends the process recorded as `pid` with start time `started` — with its
 * process group on POSIX, since the package starts its children as group
 * leaders — only if that is still the process running under that ID.
 */
export async function endProcess(
  recorded: { readonly pid: number; readonly started: string }, alive: ProcessLiveness = (pid) => processStartTime(pid),
): Promise<EndOutcome> {
  const now = await alive(recorded.pid);
  if (!now.ok) return 'cannot-tell';
  if (now.value === undefined) return 'gone';
  if (now.value !== recorded.started) return 'not-that-process';
  for (const target of ownProcessGroup(process.platform) ? [-recorded.pid, recorded.pid] : [recorded.pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone, or not a group leader after all: the other target covers it.
    }
  }
  return 'ended';
}
