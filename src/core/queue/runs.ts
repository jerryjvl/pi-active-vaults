// The daemon's own record and the processes of the runs it starts
// (daemon.md "Single instance", "Start-up recovery").
//
// One daemon runs per machine. Its record names its process — ID and start
// time — and counts only while that exact process runs, as an actor's hold
// does: a daemon that has ended, however it ended, holds nothing, and the
// next one takes the record over by compare-and-swap, so of two starting at
// once only one gets it. One whose process exists but cannot be told apart
// from a process that reused its ID still holds it (fail closed: at most one
// daemon). The record is taken before the socket is bound, so only its holder
// ever takes over a socket a crashed daemon left.
//
// Each headless session the daemon starts is recorded with its exact process
// before it runs, so recovery can end it by that identity and nothing else.
//
// Installing the daemon as a service records the directories in which its
// tools were found (config/service.ts): the machine's own state, which
// `vault doctor` reads to say when one has gone.

import type { Clock } from '../clock/index.ts';
import type { ServiceTool } from '../config/index.ts';
import type { ProcessLiveness } from '../process/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable, Store } from '../store/index.ts';

export interface RunningProcess {
  readonly pid: number;
  readonly started: string;
}

export type DaemonRecordError = { readonly reason: 'daemon-running'; readonly pid: number };

type DaemonRow = { pid: number; started: string; since: string };

function daemonRow(store: Queryable): DaemonRow | undefined {
  return store.get<DaemonRow>('SELECT pid, started, since FROM queue_daemon WHERE id = 1');
}

/** Whether the recorded process still runs; when that cannot be told, it is taken to. */
async function stands(row: DaemonRow, alive: ProcessLiveness): Promise<boolean> {
  const now = await alive(row.pid);
  return !now.ok || now.value === row.started;
}

/** The daemon that runs now, if any: what `vault doctor` and the CLI ask before acting in its place. */
export async function daemonRecord(store: Queryable, alive: ProcessLiveness): Promise<(RunningProcess & { readonly since: string }) | undefined> {
  const row = daemonRow(store);
  return row !== undefined && (await stands(row, alive)) ? row : undefined;
}

/** Takes the record for `me`, unless another daemon still runs. */
export async function takeDaemonRecord(store: Store, alive: ProcessLiveness, clock: Clock, me: RunningProcess): Promise<Result<void, DaemonRecordError>> {
  const found = daemonRow(store);
  if (found !== undefined && !(found.pid === me.pid && found.started === me.started) && (await stands(found, alive))) {
    return err({ reason: 'daemon-running', pid: found.pid });
  }
  const taken = store.transaction((tx) => {
    const now = daemonRow(tx);
    const unchanged = now === undefined ? found === undefined : found !== undefined && now.pid === found.pid && now.started === found.started;
    if (!unchanged) return false;
    tx.run(
      `INSERT INTO queue_daemon (id, pid, started, since) VALUES (1, $pid, $started, $since)
       ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, started = excluded.started, since = excluded.since`,
      { pid: me.pid, started: me.started, since: clock.now().toISOString() },
    );
    return true;
  });
  // Another daemon changed the record meanwhile: it is the one that runs.
  return taken ? ok(undefined) : err({ reason: 'daemon-running', pid: daemonRow(store)?.pid ?? 0 });
}

/** Releases the record if `me` holds it. */
export function releaseDaemonRecord(store: Store, me: RunningProcess): void {
  store.run('DELETE FROM queue_daemon WHERE id = 1 AND pid = ? AND started = ?', [me.pid, me.started]);
}

/** Records the process a spawn runs in, before it does anything. */
export function recordRunProcess(store: Store, spawn: number, process: RunningProcess): void {
  store.run(
    'INSERT INTO queue_runs (spawn, pid, started) VALUES (?, ?, ?) ON CONFLICT (spawn) DO UPDATE SET pid = excluded.pid, started = excluded.started',
    [spawn, process.pid, process.started],
  );
}

export function forgetRunProcess(store: Store, spawn: number): void {
  store.run('DELETE FROM queue_runs WHERE spawn = ?', [spawn]);
}

/** The processes of runs the daemon started and has not forgotten, by spawn. */
export function runProcesses(store: Queryable): { readonly spawn: number; readonly pid: number; readonly started: string }[] {
  return store.all<{ spawn: number; pid: number; started: string }>('SELECT spawn, pid, started FROM queue_runs ORDER BY spawn');
}

/** Records where the service's tools were found, replacing what an earlier install recorded. */
export function recordServiceTools(store: Store, tools: readonly ServiceTool[], clock: Clock): void {
  const recorded = clock.now().toISOString();
  store.transaction((tx) => {
    tx.run('DELETE FROM queue_service_tools');
    for (const { tool, dir } of tools) tx.run('INSERT INTO queue_service_tools (tool, dir, recorded) VALUES (?, ?, ?)', [tool, dir, recorded]);
  });
}

/** The tools the installed service was given, by name. */
export function recordedServiceTools(store: Queryable): ServiceTool[] {
  return store.all<ServiceTool>('SELECT tool, dir FROM queue_service_tools ORDER BY tool');
}
