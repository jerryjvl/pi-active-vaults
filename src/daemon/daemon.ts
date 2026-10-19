// The daemon (daemon.md): a thin adapter that keeps time, sockets and
// processes for the core's automation, where every decision is made.
//
//  - one per machine: it takes the daemon's record in the state database
//    (queue), then binds its socket; if another daemon holds either, it does
//    not run;
//  - before anything else, start-up recovery; then catch-up (`start`);
//  - each minute a tick (forge sync, integrity, Git events, timers, queue
//    time, the outbox, logs),
//    and every few seconds a look for work that may start; word from a
//    vault's `reference-transaction` hook — a file named after the vault in
//    `<state>/refs` — makes it look at that vault at once;
//  - the socket speaks the protocol `automation.handle` answers, and pushes
//    notices to the connections that subscribed;
//  - each MCP profile with an endpoint is served there (mcp.md); one that
//    cannot be is reported and the others still are;
//  - stopping ends its runs (recovered as restarted on the next start), its
//    socket and its record.

import { watch, type FSWatcher } from 'node:fs';
import { ensurePrivateDir, findPi, packageVersion, sweepScratch, type Host } from '../core/config/index.ts';

const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
import { createAutomation, type Automation, type Notice, type PiCommand } from '../core/automation/index.ts';
import { createContext, loadInstallation, type ContextOptions, type OperationContext } from '../core/operations/index.ts';
import { releaseDaemonRecord, takeDaemonRecord, type RecoveryReport } from '../core/queue/index.ts';
import { err, isRecord, ok, type Result } from '../core/result/index.ts';
import { listenSocket, type Channel, type ListenError, type SocketServer } from '../core/socket/index.ts';
import { startMcpEndpoint, type McpEndpoint, type McpEndpointError } from '../mcp/index.ts';

export interface DaemonOptions {
  readonly host: Host;
  /** This process (default: the current one). */
  readonly pid?: number;
  /** How Pi is started (default: the `pi` found on PATH, run with this Node). */
  readonly pi?: PiCommand;
  /** The environment headless sessions run with (default: the host's). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The local time zone timers run in (default: the system's). */
  readonly timeZone?: string;
  /** Minute ticks and polling for startable work (default true); tests drive the automation themselves. */
  readonly ticks?: boolean;
  /** Watching for word from the vaults' hooks (default true). */
  readonly watch?: boolean;
  /** Services to use instead of the system's (tests). */
  readonly context?: ContextOptions;
}

export interface RunningDaemon {
  readonly automation: Automation;
  /** What start-up recovery did. */
  readonly recovered: RecoveryReport;
  /** Each MCP profile with an endpoint: served, or why not. */
  readonly endpoints: readonly (McpEndpoint | { readonly profile: string; readonly error: McpEndpointError })[];
  stop(): Promise<void>;
}

export type DaemonStartError =
  | { readonly reason: 'installation'; readonly detail: string }
  | { readonly reason: 'already-running'; readonly pid: number }
  | { readonly reason: 'cannot-identify'; readonly pid: number }
  | { readonly reason: 'pi-not-found' }
  | ListenError;

const MINUTE_MS = 60_000;
const POLL_MS = 5_000;
/** How long word from hooks is gathered before the vaults it names are looked at. */
const SETTLE_MS = 200;

function serve(automation: Automation, schedule: () => void): (channel: Channel) => void {
  return (channel) => {
    const subscriber = (notice: Notice): void => channel.send({ notice: 'spawn', ...notice });
    channel.onMessage((message) => {
      void automation.handle(message, subscriber).then((reply) => {
        channel.send({ id: isRecord(message) ? message['id'] : undefined, ...reply });
        if (reply.ok && isRecord(message) && message['method'] === 'spawn') schedule();
      });
    });
    channel.onClose(() => automation.forget(subscriber));
  };
}

/** Starts the daemon, unless another runs; it runs until `stop`. */
export async function startDaemon(options: DaemonOptions): Promise<Result<RunningDaemon, DaemonStartError>> {
  const installation = loadInstallation(options.host);
  if (!installation.ok) return err({ reason: 'installation', detail: installation.error.reason });
  const made = createContext(installation.value, options.context);
  if (!made.ok) return err({ reason: 'installation', detail: made.error.reason });
  const context: OperationContext = made.value;
  const pid = options.pid ?? process.pid;
  const started = await context.alive(pid);
  if (!started.ok || started.value === undefined) {
    context.close();
    return err({ reason: 'cannot-identify', pid });
  }
  const me = { pid, started: started.value };
  const record = await takeDaemonRecord(context.state, context.alive, context.clock, me);
  if (!record.ok) {
    context.close();
    return err({ reason: 'already-running', pid: record.error.pid });
  }
  const quit = (): void => {
    releaseDaemonRecord(context.state, me);
    context.close();
  };
  const pi = options.pi ?? (() => {
    const found = findPi(options.host, process.execPath);
    return found.ok ? found.value : undefined;
  })();
  if (pi === undefined) {
    quit();
    return err({ reason: 'pi-not-found' });
  }

  const automation = createAutomation(context, {
    pi, env: options.env ?? options.host.env, version: packageVersion(),
    timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  // Work is looked for one pass at a time: a request arriving during a pass asks for another after it.
  let scheduling: Promise<void> | undefined;
  let again = false;
  const schedule = (): void => {
    if (scheduling !== undefined) {
      again = true;
      return;
    }
    scheduling = automation.schedule().then(() => undefined, () => undefined).finally(() => {
      scheduling = undefined;
      if (again) {
        again = false;
        schedule();
      }
    });
  };

  const server: Result<SocketServer, ListenError> = await listenSocket(installation.value.paths.socket, serve(automation, schedule));
  if (!server.ok) {
    quit();
    return server;
  }
  const recovered = await automation.start();
  // Scratch a session that never closed left behind: a day untouched is long past any run's time.
  sweepScratch(installation.value.paths, context.clock.now().getTime(), SCRATCH_MAX_AGE_MS);
  schedule();
  const endpoints: (McpEndpoint | { profile: string; error: McpEndpointError })[] = [];
  for (const profile of installation.value.mcp.profiles.filter((p) => p.listen !== undefined)) {
    const started = await startMcpEndpoint(context, profile);
    endpoints.push(started.ok ? started.value : { profile: profile.name, error: started.error });
  }

  const timers: ReturnType<typeof setInterval>[] = [];
  let ticking = Promise.resolve();
  const tick = (vault?: string): void => {
    ticking = ticking.then(() => automation.tick(vault)).then(schedule, () => undefined);
  };
  if (options.ticks !== false) {
    timers.push(setInterval(() => tick(), MINUTE_MS), setInterval(schedule, POLL_MS));
  }
  let watcher: FSWatcher | undefined;
  if (options.watch !== false) {
    const { refs } = installation.value.paths;
    ensurePrivateDir(refs);
    const named = new Set<string>();
    let settle: ReturnType<typeof setTimeout> | undefined;
    watcher = watch(refs, (_kind, file) => {
      if (typeof file === 'string' && installation.value.vaults.some((v) => v.id === file)) named.add(file);
      settle ??= setTimeout(() => {
        settle = undefined;
        for (const vault of named) tick(vault);
        named.clear();
      }, SETTLE_MS);
    });
  }

  return ok({
    automation,
    recovered,
    endpoints,
    async stop() {
      for (const timer of timers) clearInterval(timer);
      watcher?.close();
      for (const endpoint of endpoints) if ('close' in endpoint) await endpoint.close();
      await ticking;
      await scheduling;
      await automation.stop();
      await server.value.close();
      quit();
    },
  });
}
