// Which process is which: a process ID together with that process's start
// time. A record naming a process — an actor's hold, a headless session the
// daemon started — counts only while a process with that ID and that start
// time runs, so a session that has ended holds nothing however it ended, and
// an ID the system has since given to another process never matches.
//
// Each platform is asked in its own way, by exact process ID, never by name:
// Linux reads `/proc` (the start in clock ticks, with the boot it belongs to);
// macOS asks `ps`; Windows asks PowerShell. When the answer cannot be read,
// that is its own result, `cannot-tell`, for the caller to treat as it must.

import { readFileSync } from 'node:fs';
import { err, ok, type Result } from '../result/index.ts';
import { runProcess, type ProcessError, type ProcessOutcome, type ProcessRequest } from './run.ts';

export interface ProcessProbe {
  readonly platform: NodeJS.Platform;
  /** A file's text, or undefined when it cannot be read. */
  readonly readFile: (path: string) => string | undefined;
  readonly run: (request: ProcessRequest) => Promise<Result<ProcessOutcome, ProcessError>>;
}

export type ProcessStartError = { readonly reason: 'cannot-tell'; readonly pid: number };

/** The start time of the process with `pid` while it runs: undefined once it has ended. */
export type ProcessLiveness = (pid: number) => Promise<Result<string | undefined, ProcessStartError>>;

const systemProbe: ProcessProbe = {
  platform: process.platform,
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  run: runProcess,
};

const ASK_TIMEOUT_MS = 10_000;
// `/proc/<pid>/stat` after the command name: field 3 (state) onwards; the start time is field 22.
const STATE_FIELD = 0;
const START_FIELD = 19;

function linuxStart(pid: number, probe: ProcessProbe): Result<string | undefined, ProcessStartError> {
  const stat = probe.readFile(`/proc/${pid}/stat`);
  if (stat === undefined) return ok(undefined);
  // The command name is in parentheses and may contain anything, so fields are counted from its end.
  const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const start = fields[START_FIELD];
  const boot = probe.readFile('/proc/sys/kernel/random/boot_id')?.trim();
  if (start === undefined || !/^\d+$/.test(start) || boot === undefined || boot === '') return err({ reason: 'cannot-tell', pid });
  return ok(fields[STATE_FIELD] === 'Z' ? undefined : `linux:${boot}:${start}`);
}

async function askedStart(pid: number, probe: ProcessProbe, request: ProcessRequest, label: string, shape: RegExp): Promise<Result<string | undefined, ProcessStartError>> {
  const ran = await probe.run(request);
  if (!ran.ok || ran.value.timedOut) return err({ reason: 'cannot-tell', pid });
  if (ran.value.exitCode !== 0) return ok(undefined);
  const answer = ran.value.stdout.toString('utf8').trim();
  return shape.test(answer) ? ok(`${label}:${answer}`) : err({ reason: 'cannot-tell', pid });
}

const asking = (file: string, args: string[]): ProcessRequest =>
  ({ program: { file, args }, env: {}, timeoutMs: ASK_TIMEOUT_MS, maxStdoutBytes: 4096, maxStderrBytes: 4096 });

/** The start time of the process `pid`, or undefined when no such process runs. */
export async function processStartTime(pid: number, probe: ProcessProbe = systemProbe): Promise<Result<string | undefined, ProcessStartError>> {
  if (!Number.isInteger(pid) || pid <= 0) return ok(undefined);
  switch (probe.platform) {
    case 'win32':
      return askedStart(pid, probe, asking('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks } else { exit 1 }`,
      ]), 'win32', /^\d+$/);
    case 'darwin':
      return askedStart(pid, probe, asking('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]), 'darwin', /^\S.*\d$/);
    default:
      return linuxStart(pid, probe);
  }
}
