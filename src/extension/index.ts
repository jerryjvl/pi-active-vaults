// The Pi extension (extension.md, api.md): vault operations as tools and
// `/vault` commands, the flags a session is started with, and the hooks that
// supply context, guard writes and account for work — a thin adapter from
// Pi's API to the core, where every decision is made.
//
// The factory registers tools, commands, flags and hooks, and nothing else
// (pi-conventions.md "Extension lifecycle"): Pi sometimes loads extensions
// without starting a session, so everything with a lifetime — the state
// database, the actor's hold, event bus subscriptions — starts at
// `session_start` and ends at `session_shutdown`.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { currentHost, type Host } from '../core/config/index.ts';
import type { ContextOptions } from '../core/operations/index.ts';
import { registerCommands } from './commands.ts';
import { fanOutTool } from './fan-out.ts';
import { registerHooks } from './hooks.ts';
import type { ItemSessionOptions } from './item-session.ts';
import type { Holder } from './live.ts';
import { registerTools } from './tools.ts';

export interface ExtensionOptions {
  /** The machine; read from the process when the session starts if absent. */
  readonly host?: Host;
  /** The process that holds the session's actor; this one if absent. */
  readonly pid?: number;
  /** Services to use instead of the system's (tests). */
  readonly context?: ContextOptions;
  /** The model runtime and agent directory for fan-out item sessions, instead of Pi's own (tests). */
  readonly items?: ItemSessionOptions;
}

export function createExtension(options: ExtensionOptions = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const holder: Holder = {};
    const host = (): Host => options.host ?? currentHost();
    pi.registerFlag('vault-run', { type: 'string', description: 'Headless run context written by the vault daemon: actor, budget, trace, triggering event' });
    pi.registerFlag('vault-actor', { type: 'string', description: 'The actor this session writes as (default: from the vault worktree, else the installation\'s person)' });
    registerTools(pi, holder);
    pi.registerTool(fanOutTool(pi, holder, options.items));
    registerCommands(pi, holder, host);
    registerHooks(pi, holder, { host, pid: options.pid ?? process.pid, ...(options.context === undefined ? {} : { context: options.context }) });
  };
}

export default createExtension();
