// Full trace logs on the machine (concepts.md "Trace", daemon.md "Log
// rotation"): `<logs>/<yyyy-mm-dd>/<trace-id>/<name>`, one directory per day
// and trace, written as JSON lines and kept for `logs.keep-days`.
//
// Invariants: days are UTC dates, like trace IDs, so a log's day never depends
// on the machine's time zone; directories and files are readable by the user
// only; a trace ID or log name that could leave the log directory is refused;
// rotation touches only directories named as days, leaves today's files as
// written, compresses earlier days' files, and deletes days older than the
// retention — so rotating twice changes nothing more.

import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { utcDay, type Clock } from '../clock/index.ts';
import { ensurePrivateDir } from '../config/index.ts';
import { isTraceId } from '../ids/index.ts';
import { err, ok, type Result } from '../result/index.ts';

export type LogError =
  | { readonly reason: 'invalid-name' }
  | { readonly reason: 'unwritable'; readonly code: string };

export interface LogEntry {
  readonly day: string;
  readonly name: string;
  readonly text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOG_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const COMPRESSED = '.gz';

function validName(name: string): boolean {
  return LOG_NAME.test(name) && !name.endsWith(COMPRESSED);
}

/** Appends one JSON line to the trace's log `name` for today. */
export function appendFullLog(logs: string, clock: Clock, trace: string, name: string, record: unknown): Result<void, LogError> {
  if (!isTraceId(trace) || !validName(name)) return err({ reason: 'invalid-name' });
  const directory = join(logs, utcDay(clock.now()), trace);
  try {
    ensurePrivateDir(logs);
    ensurePrivateDir(join(logs, utcDay(clock.now())));
    ensurePrivateDir(directory);
    appendFileSync(join(directory, name), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return ok(undefined);
  } catch (error) {
    return err({ reason: 'unwritable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
  }
}

function dayDirectories(logs: string): string[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).filter((day) => DAY.test(day) && statSync(join(logs, day)).isDirectory()).sort();
}

/** Every retained log of the trace, oldest day first, compressed ones read back as written. */
export function readFullLog(logs: string, trace: string): LogEntry[] {
  if (!isTraceId(trace)) return [];
  const entries: LogEntry[] = [];
  for (const day of dayDirectories(logs)) {
    const directory = join(logs, day, trace);
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory).sort()) {
      const compressed = file.endsWith(COMPRESSED);
      const name = compressed ? file.slice(0, -COMPRESSED.length) : file;
      if (!validName(name)) continue;
      const bytes = readFileSync(join(directory, file));
      entries.push({ day, name, text: (compressed ? gunzipSync(bytes) : bytes).toString('utf8') });
    }
  }
  return entries;
}

/** Compresses `file` beside itself, then removes it; the compressed copy is complete before the original goes. */
function compress(file: string): void {
  const partial = `${file}${COMPRESSED}.partial`;
  writeFileSync(partial, gzipSync(readFileSync(file)), { mode: 0o600 });
  renameSync(partial, `${file}${COMPRESSED}`);
  unlinkSync(file);
}

/** Applies the retention: returns the files compressed (relative to `logs`) and the days deleted. */
export function rotateLogs(logs: string, clock: Clock, keepDays: number): { compressed: string[]; deleted: string[] } {
  const today = Date.parse(utcDay(clock.now()));
  const compressed: string[] = [];
  const deleted: string[] = [];
  for (const day of dayDirectories(logs)) {
    const age = Math.round((today - Date.parse(day)) / DAY_MS);
    if (age >= keepDays) {
      rmSync(join(logs, day), { recursive: true, force: true });
      deleted.push(day);
    } else if (age >= 1) {
      for (const trace of readdirSync(join(logs, day)).sort()) {
        const directory = join(logs, day, trace);
        if (!isTraceId(trace) || !statSync(directory).isDirectory()) continue;
        for (const file of readdirSync(directory).sort()) {
          if (!validName(file)) continue;
          compress(join(directory, file));
          compressed.push(`${day}/${trace}/${file}`);
        }
      }
    }
  }
  return { compressed, deleted };
}
