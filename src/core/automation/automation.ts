// The daemon's work (daemon.md), as one object the daemon adapter drives:
// `start` once, `tick` each minute (and when a vault's hook says its refs
// changed), `schedule` whenever work may have become startable, `handle` for
// each socket request — so the adapter only keeps time, sockets and
// processes, and every decision is here and below.
//
//  - start: start-up recovery (queue), then a first tick, which catches up on
//    everything since the cursors — the slots missed while it was down too;
//  - tick: forge sync first (a merge in the forge moves the accepted main,
//    and each merged proposal is checked for its commits reaching it), then
//    backups of local-mode vaults that name a remote (backups.ts), then
//    which vaults it runs and which are paused (their owners told once), the Git events since each job's cursor, the timers that came due,
//    queued work past its queue time, the notification spools (spools.ts),
//    the outbox's retries, and log rotation;
//  - schedule: starts what may start — in priority order, within capacity,
//    one job per actor, nothing for a paused vault — and tells subscribers
//    as runs start and finish;
//  - stop: ends the runs in progress, recorded as stopped by a restart.

import { rotateLogs } from '../traces/index.ts';
import type { Slot } from '../conditions/index.ts';
import { localSlot } from '../conditions/index.ts';
import { usedToday } from '../budgets/index.ts';
import { deliverDue } from '../notify/index.ts';
import { notifyDeps, scriptEnvironment, spawnMatching, type OperationContext } from '../operations/index.ts';
import { expireQueued, listSpawns, recoverRuns, runProcesses, schedulable, type RecoveryReport, type SpawnEntry, type SpawnMatching } from '../queue/index.ts';
import { scanGitEvents } from './events.ts';
import { createBackups } from './backups.ts';
import { createSpools } from './spools.ts';
import { createForgeSync } from './forge.ts';
import { METHODS, answer, claimRequested, inTree, noticeOf, readRequest, refuse, type Notice, type Reply } from './protocol.ts';
import { startRun, type PiCommand, type RunHandle } from './run.ts';
import { tickTimers } from './timers.ts';
import { hostedVaults, pausedVaults, tellOwners } from './vaults.ts';

export interface AutomationOptions {
  readonly pi: PiCommand;
  /** The environment headless sessions run with: the user's own. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The local time zone timers run in (an IANA name). */
  readonly timeZone: string;
  /** The package's version, for `ping`. */
  readonly version: string;
  /** Extra time past a run's run time before it is killed (default one minute). */
  readonly graceMs?: number;
}

export interface Automation {
  start(): Promise<RecoveryReport>;
  /** One pass; `vault` limits Git events to that vault's (its hook said its refs changed). */
  tick(vault?: string): Promise<void>;
  schedule(): Promise<SpawnEntry[]>;
  /** Resolves once no run is in progress. */
  idle(): Promise<void>;
  /** Answers one request; `subscriber` receives the notices a `subscribe` asks for, until `forget`. */
  handle(request: unknown, subscriber: (notice: Notice) => void): Promise<Reply>;
  forget(subscriber: (notice: Notice) => void): void;
  /** Every notice, for the adapter's own use (and tests). */
  watch(listener: (notice: Notice) => void): void;
  stop(): Promise<void>;
}

const MINUTE_MS = 60_000;
/** A tick this long after the last one means the process was suspended: what came due meanwhile was missed. */
const SUSPENDED_MS = 2 * MINUTE_MS;
const DEFAULT_GRACE_MS = MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;

export function createAutomation(context: OperationContext, options: AutomationOptions): Automation {
  const runs = new Map<number, RunHandle>();
  const subscribers = new Map<(notice: Notice) => void, string>();
  const listeners: ((notice: Notice) => void)[] = [];
  const sessionFiles = new Map<string, string>();
  const told = new Set<string>();
  let paused = new Set<string>();
  let lastTick: { at: number; slot: Slot } | undefined;
  let lastRotation = Number.NEGATIVE_INFINITY;
  let matching: Promise<SpawnMatching> | undefined;
  const matchingOf = (): Promise<SpawnMatching> => (matching ??= spawnMatching(context));
  const forge = createForgeSync(context);
  const backups = createBackups(context);
  const spools = createSpools(context);

  const tell = (notice: Notice): void => {
    for (const listener of listeners) listener(notice);
    for (const [subscriber, trace] of subscribers) if (inTree(notice, trace)) subscriber(notice);
  };

  const tick = async (only?: string): Promise<void> => {
    const now = context.clock.now();
    if (only === undefined) await forge.tick(await hostedVaults(context));
    // Every vault here is backed up, hosted or not: its repository is on this machine.
    await backups.tick(only === undefined ? context.installation.vaults : context.installation.vaults.filter((v) => v.id === only));
    // Syncing may have moved an accepted main, and with it where the vault is run.
    const hosted = await hostedVaults(context);
    const unaccepted = await pausedVaults(context, context.installation.vaults);
    for (const vault of hosted) {
      const change = unaccepted.get(vault.id);
      if (change !== undefined) await tellOwners(context, vault, change, told);
    }
    const nowPaused = new Set(unaccepted.keys());
    const resumed = new Set([...paused].filter((id) => !nowPaused.has(id)));
    paused = nowPaused;
    const m = await matchingOf();
    await scanGitEvents(context, m, hosted, paused, only);
    if (only === undefined) {
      const kept = lastTick !== undefined && now.getTime() - lastTick.at < SUSPENDED_MS;
      await tickTimers(context, m, hosted, paused, {
        now, timeZone: options.timeZone, resumed, ...(kept && lastTick !== undefined ? { previous: lastTick.slot } : {}),
      });
      lastTick = { at: now.getTime(), slot: localSlot(now, options.timeZone) };
      expireQueued(context.state, context.clock, context.installation.config.daemon.queueTimeMs);
      await spools.tick();
      const outbox = notifyDeps(context, scriptEnvironment(context.installation));
      if (outbox !== undefined) await deliverDue(outbox);
      if (now.getTime() - lastRotation >= HOUR_MS) {
        rotateLogs(context.installation.paths.logs, context.clock, context.installation.config.logs.keepDays);
        lastRotation = now.getTime();
      }
    }
  };

  const schedule = async (): Promise<SpawnEntry[]> => {
    const unaccepted = await pausedVaults(context, context.installation.vaults);
    const candidates = await schedulable(context.state, context.alive, context.installation.config.daemon.parallel);
    const started: SpawnEntry[] = [];
    for (const spawn of candidates.filter((s) => !unaccepted.has(s.vault))) {
      const handle = await startRun(context, {
        pi: options.pi, env: options.env, graceMs: options.graceMs ?? DEFAULT_GRACE_MS, sessionFile: (session) => sessionFiles.get(session),
      }, spawn, {
        started: (s) => tell(noticeOf('started', s)),
        finished: (s) => tell(noticeOf('finished', s)),
      });
      if (handle === undefined) continue;
      started.push(handle.spawn);
      if (handle.spawn.state === 'running') {
        runs.set(spawn.id, handle);
        void handle.ended.finally(() => runs.delete(spawn.id));
      }
    }
    return started;
  };

  const idle = async (): Promise<void> => {
    while (runs.size > 0) await Promise.allSettled([...runs.values()].map((r) => r.ended));
  };

  const status = (): unknown => {
    const running = listSpawns(context.state, { states: ['running'] });
    const processes = new Map(runProcesses(context.state).map((p) => [p.spawn, p.pid]));
    const { dailyTokens } = context.installation.config.budgets;
    return {
      queued: listSpawns(context.state, { states: ['queued'] }).map((s) => ({ vault: s.vault, document: s.document, trace: s.trace, actor: s.actor, claimed: s.claimed })),
      running: running.map((s) => ({ vault: s.vault, document: s.document, trace: s.trace, actor: s.actor, started: s.started, pid: processes.get(s.id) })),
      paused: [...paused].sort(),
      forge: forge.outcomes(),
      backups: backups.outcomes(),
      spools: spools.outcomes(),
      budgets: { dailyUsed: usedToday(context.state, context.clock), ...(dailyTokens === undefined ? {} : { dailyTokens }) },
    };
  };

  return {
    async start() {
      const report = await recoverRuns({
        git: context.git, store: context.state, alive: context.alive, clock: context.clock, logs: context.installation.paths.logs, vaults: context.installation.vaults,
      });
      await tick();
      return report;
    },
    tick,
    schedule,
    idle,
    async handle(message, subscriber) {
      const request = readRequest(message);
      if ('ok' in request) return request;
      const { method, params } = request;
      switch (method) {
        case 'ping':
          return answer({ version: options.version, capabilities: [...METHODS] });
        case 'status':
          return answer(status());
        case 'spawn':
          return claimRequested(context, await matchingOf(), params);
        case 'subscribe': {
          const { trace, session, file } = params;
          if (typeof trace !== 'string') return refuse('invalid-request');
          subscribers.set(subscriber, trace);
          // A session that says where its file is can be forked by the spawns it triggers.
          if (typeof session === 'string' && typeof file === 'string') sessionFiles.set(session, file);
          return answer({});
        }
        case 'stop': {
          const { trace } = params;
          const run = [...runs.values()].find((r) => r.spawn.trace === trace);
          if (run === undefined) return refuse('not-running', { trace });
          run.stop('requested');
          return answer({});
        }
      }
    },
    forget(subscriber) {
      subscribers.delete(subscriber);
    },
    watch(listener) {
      listeners.push(listener);
    },
    async stop() {
      for (const run of runs.values()) run.stop('restart');
      await idle();
    },
  };
}
