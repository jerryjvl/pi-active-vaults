// What every operation runs with: the loaded installation and the services
// the core takes as inputs — Git, the stores, a clock, IDs, HTTP, secrets,
// process liveness, how scripts run, and the one cache of what is read from
// accepted mains. Adapters build one per process (the CLI per command, the
// extension per session, the daemon once); tests build one with fakes. Nothing here decides anything about a vault.
//
// Invariants:
//  - scripts and checks get an environment made only of the variables an
//    interpreter needs to start (no tokens, no passwords from the caller's
//    environment), so a secret reaches a script only through `!command` or
//    `${ENV}` resolution, which scripts never see;
//  - the search index is opened only when an operation needs it, so a broken
//    or newer index degrades search rather than every command;
//  - commits and notes made for a person or actor are attributed to a fixed,
//    derived identity, never to whatever the machine's Git config says.

import { randomBytes } from 'node:crypto';
import { systemClock, type Clock } from '../clock/index.ts';
import { systemSecretDeps, type SecretDeps } from '../config/index.ts';
import { createGit, type Git, type Identity } from '../git/index.ts';
import type { HttpClient } from '../http/index.ts';
import { createIdSource, type IdSource } from '../ids/index.ts';
import { createAcceptedReads, type AcceptedReads } from '../integrity/index.ts';
import { processStartTime, type ProcessLiveness } from '../process/index.ts';
import type { Result } from '../result/index.ts';
import { findWindowsShell, probeNetworkSandbox, type CheckRunOptions, type NetworkSandbox } from '../scripts/index.ts';
import type { Store, StoreError } from '../store/index.ts';
import type { SpawnSender } from '../queue/index.ts';
import type { Installation } from './installation.ts';
import { openIndexStore, openStateStore } from './stores.ts';

export interface OperationContext {
  readonly installation: Installation;
  readonly git: Git;
  readonly state: Store;
  /** The search index, opened on first use. */
  index(): Result<Store, StoreError>;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly http: HttpClient;
  readonly secrets: SecretDeps;
  readonly alive: ProcessLiveness;
  /** What has been read from the vaults' accepted mains, kept while they stay accepted (architecture.md). */
  readonly reads: AcceptedReads;
  /** Sends a spawn request to the running daemon; absent when none runs, and requests are queued here instead. */
  readonly send?: SpawnSender;
  /** How scripts and checks run here. */
  scriptOptions(): Promise<CheckRunOptions>;
  /** Where SMTP connects and what it trusts besides the system — a test seam only. */
  readonly smtp?: { readonly port?: number; readonly ca?: string; readonly timeoutMs?: number };
  /** Where a long operation tells a person how far it has got (the CLI's standard error); absent elsewhere. */
  readonly progress?: (line: string) => void;
  close(): void;
}

export interface ContextOptions {
  readonly git?: Git;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly fetch?: typeof fetch;
  readonly secrets?: SecretDeps;
  readonly alive?: ProcessLiveness;
  readonly sandbox?: NetworkSandbox;
  readonly smtp?: OperationContext['smtp'];
  /** The daemon link's sender, when a daemon runs. */
  readonly send?: SpawnSender;
  readonly progress?: OperationContext['progress'];
}

/** A script's time limit: scripts are exact, bounded work, not sessions. */
export const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/** What interpreters need to start, per platform family; nothing else of the caller's environment. */
const SCRIPT_VARIABLES: Readonly<Record<'posix' | 'win32', readonly string[]>> = {
  posix: ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'],
  win32: ['PATH', 'PATHEXT', 'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'USERNAME'],
};

export function scriptEnvironment(installation: Pick<Installation, 'host'>): Record<string, string> {
  const { host } = installation;
  const names = SCRIPT_VARIABLES[host.os === 'win32' ? 'win32' : 'posix'];
  return Object.fromEntries(names.flatMap((name) => (host.env[name] === undefined ? [] : [[name, host.env[name] as string]])));
}

/**
 * The Git identity commits and notes are made as for `name` (a person or an
 * actor): the name itself, at this installation — so history says which
 * installation made them without depending on the machine's Git config.
 */
export function packageIdentity(installation: Pick<Installation, 'config'>, name: string): Identity {
  const at = installation.config.name.slice(installation.config.name.lastIndexOf('@') + 1).replace(/[^A-Za-z0-9.-]/g, '-') || 'localhost';
  return { name, email: `${name.replace(/[^A-Za-z0-9._+-]/g, '-')}@${at}` };
}

export function createContext(installation: Installation, options: ContextOptions = {}): Result<OperationContext, StoreError> {
  const state = openStateStore(installation.paths);
  if (!state.ok) return state;
  const clock = options.clock ?? systemClock;
  const git = options.git ?? createGit({ env: installation.host.env as NodeJS.ProcessEnv });
  let index: Result<Store, StoreError> | undefined;
  let scripts: Promise<CheckRunOptions> | undefined;
  const os = installation.host.os;
  const reads = createAcceptedReads();
  return {
    ok: true,
    value: {
      installation,
      git,
      state: state.value,
      index: () => (index ??= openIndexStore(installation.paths)),
      clock,
      ids: options.ids ?? createIdSource({ clock, randomBytes: (n) => randomBytes(n) }),
      http: { fetch: options.fetch ?? fetch },
      secrets: options.secrets ?? systemSecretDeps(installation.host.env),
      alive: options.alive ?? ((pid) => processStartTime(pid)),
      reads,
      scriptOptions: () => (scripts ??= (async () => {
        const env = scriptEnvironment(installation);
        const sandbox = options.sandbox ?? await probeNetworkSandbox(os, env);
        const windowsShell = os === 'win32' ? await findWindowsShell(git) : undefined;
        return { env, timeoutMs: SCRIPT_TIMEOUT_MS, os, sandbox, reads, ...(windowsShell === undefined ? {} : { windowsShell }) };
      })()),
      ...(options.smtp === undefined ? {} : { smtp: options.smtp }),
      ...(options.send === undefined ? {} : { send: options.send }),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
      close: () => {
        state.value.close();
        if (index?.ok) index.value.close();
      },
    },
  };
}
