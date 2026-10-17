// Which process is which: a process ID together with that process's start
// time. A record naming a process — an actor's hold, a headless session the
// daemon started — counts only while a process with that ID and that start
// time runs, so a session that has ended holds nothing however it ended, and
// an ID the system has since given to another process never matches.
//
// Existence is tested first, the same way on every platform (signal 0: ESRCH
// means no such process, EPERM means one exists that is not ours), so a
// process that has ended is known to have ended without asking anything that
// might fail to answer. Only for a process that exists is its start time
// asked, in each platform's own way, by exact process ID, never by name:
// Linux reads `/proc` (the start in clock ticks, with the boot it belongs to);
// macOS asks `ps`; Windows asks Windows PowerShell, by its absolute path under
// `%SystemRoot%` and with the few variables it needs to start, since programs
// run with exactly the environment given. When the answer cannot be read,
// that is its own result, `cannot-tell` — which therefore only ever describes
// a process that exists — for the caller to treat as it must.

import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';
import { runProcess, type ProcessError, type ProcessOutcome, type ProcessRequest } from './run.ts';

export interface ProcessProbe {
  readonly platform: NodeJS.Platform;
  /** The environment the asking program's variables are taken from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a process with this ID exists; `unknown` when the system gave another answer. */
  readonly exists: (pid: number) => 'exists' | 'gone' | 'unknown';
  /** A file's text, or undefined when it cannot be read. */
  readonly readFile: (path: string) => string | undefined;
  readonly run: (request: ProcessRequest) => Promise<Result<ProcessOutcome, ProcessError>>;
}

export type ProcessStartError = { readonly reason: 'cannot-tell'; readonly pid: number };

/** The start time of the process with `pid` while it runs: undefined once it has ended. */
export type ProcessLiveness = (pid: number) => Promise<Result<string | undefined, ProcessStartError>>;

export const systemProcessProbe: ProcessProbe = {
  platform: process.platform,
  env: process.env,
  exists: (pid) => {
    try {
      // Signal 0 sends nothing; it only checks that the process could be signalled.
      process.kill(pid, 0);
      return 'exists';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'exists' : 'unknown';
    }
  },
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

const asking = (file: string, args: string[], env: Readonly<Record<string, string | undefined>> = {}): ProcessRequest =>
  ({ program: { file, args }, env, timeoutMs: ASK_TIMEOUT_MS, maxStdoutBytes: 4096, maxStderrBytes: 4096 });

/**
 * What Windows PowerShell needs to start and load its own modules: the system
 * root (the runtime will not start without it), the system drive, and the
 * profile and temporary directories it writes its caches to. Nothing else of
 * the caller's environment reaches it.
 */
const POWERSHELL_VARIABLES = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData'];

function windowsAsk(pid: number, env: ProcessProbe['env']): ProcessRequest | undefined {
  const root = env['SystemRoot'];
  if (root === undefined || !win32.isAbsolute(root)) return undefined;
  const passed = Object.fromEntries(POWERSHELL_VARIABLES.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
  return asking(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks } else { exit 1 }`,
  ], passed);
}

/** The start time of the process `pid`, or undefined when no such process runs. */
export async function processStartTime(pid: number, probe: ProcessProbe = systemProcessProbe): Promise<Result<string | undefined, ProcessStartError>> {
  if (!Number.isInteger(pid) || pid <= 0) return ok(undefined);
  if (probe.exists(pid) === 'gone') return ok(undefined);
  switch (probe.platform) {
    case 'win32': {
      const request = windowsAsk(pid, probe.env);
      return request === undefined ? err({ reason: 'cannot-tell', pid }) : askedStart(pid, probe, request, 'win32', /^\d+$/);
    }
    case 'darwin':
      return askedStart(pid, probe, asking('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]), 'darwin', /^\S.*\d$/);
    default:
      return linuxStart(pid, probe);
  }
}
