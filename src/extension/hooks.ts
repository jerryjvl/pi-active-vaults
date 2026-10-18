// The session lifecycle (extension.md "Session lifecycle", api.md "Hooks"),
// adapted from Pi's events to the core's `sessions` module, which decides
// everything:
//
//  - session_start: load the installation, open the vault session (actor,
//    hold, trace, budget — or, headless, refuse and shut down), fix the
//    catalog, handle the start as a session event, publish `ready`;
//  - before_agent_start: the catalog as a prompt section, and whatever is
//    waiting for the model (start notices, a run's brief, start documents);
//  - tool_call: the write guard (blocking deliberately, with the reason), then
//    the tool and the paths it touches as session events;
//  - tool_result: taint, and the context the call's paths brought in;
//  - turn_end and session_compact: the turn's work against the budget; a
//    headless run past its limits is stopped;
//  - session_shutdown: release everything, as often as it is called.

import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import { usageOf } from '../core/budgets/index.ts';
import type { Host } from '../core/config/index.ts';
import {
  createContext, describeError, loadInstallation, locate, operationNamed, paramsOn, splitVaultPath, type ContextOptions,
} from '../core/operations/index.ts';
import {
  catalogText, closeSession, guardToolCall, openSession, parseRunContext, recordTurn, renderInjections, sessionEvent, taints,
  type GuardedCall, type SessionEvent, type VaultSession,
} from '../core/sessions/index.ts';
import type { OperationContext } from '../core/operations/index.ts';
import { BUS_METHODS, subscribeRequests } from './bus.ts';
import type { Holder, Live } from './live.ts';
import { publishSpawns, VERSION_CHANNEL } from './operate.ts';
import { readsOf, shellOf, writesOf } from './paths.ts';

export interface HookOptions {
  readonly host: () => Host;
  readonly pid: number;
  readonly context?: ContextOptions;
}



function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** Why the session cannot have a vault session, told to the person; a headless run then ends. */
function fail(holder: Holder, ctx: ExtensionContext, headless: boolean, problem: string): void {
  holder.problem = problem;
  ctx.ui.notify(problem, 'error');
  if (headless) ctx.shutdown();
}

async function start(pi: ExtensionAPI, holder: Holder, options: HookOptions, ctx: ExtensionContext): Promise<void> {
  const runFile = pi.getFlag('vault-run');
  const actor = pi.getFlag('vault-actor');
  const headless = typeof runFile === 'string' && runFile !== '';
  const installation = loadInstallation(options.host());
  if (!installation.ok) return fail(holder, ctx, headless, `Vaults: the installation cannot be loaded. ${describeError(installation.error)}`);
  const made = createContext(installation.value, options.context);
  if (!made.ok) return fail(holder, ctx, headless, `Vaults: the state database cannot be opened (${made.error.reason}).`);
  const context = made.value;

  let run;
  if (headless) {
    let text: string;
    try {
      text = readFileSync(runFile, 'utf8');
    } catch {
      context.close();
      return fail(holder, ctx, true, `Vaults: the run file ${runFile} cannot be read; the run does not start.`);
    }
    const parsed = parseRunContext(text);
    if (!parsed.ok) {
      context.close();
      return fail(holder, ctx, true, `Vaults: the run file is not valid (${parsed.error.map((i) => `${i.path || 'file'}: ${i.message}`).join('; ')}); the run does not start.`);
    }
    run = parsed.value;
  }
  const opened = await openSession(context, {
    session: ctx.sessionManager.getSessionId(), pid: options.pid, cwd: ctx.cwd,
    ...(typeof actor === 'string' && actor !== '' ? { actor } : {}), ...(run === undefined ? {} : { run }),
  });
  if (!opened.ok) {
    context.close();
    return fail(holder, ctx, true, `Vaults: the run does not start (${opened.error.reason}).`);
  }
  const { session, notices } = opened.value;
  const live: Live = { context, session, cwd: ctx.cwd, catalog: await catalogText(context), pending: [], forResult: new Map(), subscriptions: [] };
  holder.live = live;
  holder.problem = undefined;
  for (const notice of notices) ctx.ui.notify(notice, 'warning');
  live.pending.push(...notices);
  if (session.brief !== undefined) live.pending.push(session.brief);
  live.pending.push(...(await handle(pi, live, { kind: 'session.start', ...modelOf(ctx) })));
  live.subscriptions.push(subscribeRequests(pi, holder));
  pi.events.emit(`${VERSION_CHANNEL}:ready`, { version: packageVersion(), capabilities: [...BUS_METHODS], trace: session.trace });
}

const modelOf = (ctx: ExtensionContext): { model?: string } => (ctx.model === undefined ? {} : { model: ctx.model.id });

/** Handles a session event: published, and what it injects and spawns, as text for the model. */
async function handle(pi: ExtensionAPI, live: Live, event: SessionEvent): Promise<string[]> {
  const outcome = await sessionEvent(live.context, live.session, event);
  if (!outcome.fresh) return [];
  pi.events.emit(`${VERSION_CHANNEL}:event`, event);
  publishSpawns(pi, outcome.spawns);
  const spawned = outcome.spawns.filter((s) => s.state === 'queued').map((s) => `Spawned ${s.vault}:${s.document} (trace ${s.trace}).`);
  return [
    ...(outcome.injections.length === 0 ? [] : [renderInjections(outcome.injections)]),
    ...spawned, ...outcome.notes,
  ];
}

/** The vault paths a call touches: files of Pi's tools inside a vault, and the vault paths of vault tools. */
function touched(context: OperationContext, event: ToolCallEvent, cwd: string): { vault: string; path: string }[] {
  const { vaults } = context.installation;
  const found: { vault: string; path: string }[] = [];
  for (const file of [...readsOf(event.toolName, event.input, cwd), ...writesOf(event.toolName, event.input, cwd)]) {
    const at = locate(vaults, file);
    if (at !== undefined && at.path !== '') found.push({ vault: at.vault.id, path: at.path });
  }
  const operation = event.toolName.startsWith('vault_') ? operationNamed(event.toolName.slice('vault_'.length)) : undefined;
  for (const spec of operation === undefined ? [] : paramsOn(operation, 'tool').filter((p) => p.vaultPath === true)) {
    const value = (event.input as Readonly<Record<string, unknown>>)[spec.name];
    for (const text of typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []) {
      const split = splitVaultPath(vaults, text);
      if (split.vault !== undefined && split.path !== '') found.push({ vault: split.vault.id, path: split.path });
    }
  }
  return found.filter((f, i) => found.findIndex((g) => g.vault === f.vault && g.path === f.path) === i);
}

function guarded(event: ToolCallEvent, cwd: string): GuardedCall[] {
  const command = shellOf(event.toolName, event.input);
  return [
    ...writesOf(event.toolName, event.input, cwd).map((path) => ({ kind: 'write' as const, path })),
    ...(command === undefined ? [] : [{ kind: 'shell' as const, command, cwd }]),
  ];
}

function usages(...found: (Usage | undefined)[]) {
  return found.filter((u): u is Usage => u !== undefined).map(usageOf);
}

function stopIfOver(pi: ExtensionAPI, session: VaultSession, ctx: ExtensionContext, stop: string | undefined): void {
  if (stop === undefined) return;
  pi.events.emit(`${VERSION_CHANNEL}:spawn`, { state: 'stopped', reason: stop, trace: session.trace });
  ctx.ui.notify(`Vaults: the run is over its ${stop === 'ttl' ? 'run time' : 'budget'} and stops.`, 'error');
  ctx.abort();
  ctx.shutdown();
}

export function registerHooks(pi: ExtensionAPI, holder: Holder, options: HookOptions): void {
  pi.on('session_start', async (_event, ctx) => start(pi, holder, options, ctx));

  pi.on('before_agent_start', async (event) => {
    const live = holder.live;
    if (live === undefined) return undefined;
    event.systemPromptOptions.sections['vault-catalog'] = live.catalog;
    if (live.pending.length === 0) return undefined;
    const content = live.pending.splice(0).join('\n\n');
    return { message: { customType: 'pav:context', content, display: false } };
  });

  pi.on('tool_call', async (event, ctx) => {
    const live = holder.live;
    if (live === undefined) return undefined;
    for (const call of guarded(event, ctx.cwd)) {
      // Throwing would block too; a returned block carries the reason the model acts on.
      const verdict = await guardToolCall(live.context, live.session, call);
      if (!verdict.allowed) return { block: true, reason: verdict.reason };
    }
    const brought = await handle(pi, live, { kind: 'session.tool', tool: event.toolName, ...modelOf(ctx) });
    for (const { vault, path } of touched(live.context, event, ctx.cwd)) brought.push(...(await handle(pi, live, { kind: 'session.path', vault, path, ...modelOf(ctx) })));
    if (brought.length > 0) live.forResult.set(event.toolCallId, brought);
    return undefined;
  });

  pi.on('tool_result', async (event, ctx) => {
    const live = holder.live;
    if (live === undefined) return undefined;
    const { config, vaults } = live.context.installation;
    if (!live.session.tainted && taints(config.taint, vaults, { tool: event.toolName, reads: readsOf(event.toolName, event.input, ctx.cwd) })) live.session.tainted = true;
    const brought = live.forResult.get(event.toolCallId);
    if (brought === undefined) return undefined;
    live.forResult.delete(event.toolCallId);
    return {
      content: [...event.content, { type: 'text' as const, text: brought.join('\n\n') }],
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  });

  pi.on('turn_end', async (event, ctx) => {
    const live = holder.live;
    if (live === undefined) return undefined;
    const message = event.message as { role: string; usage?: Usage };
    const turn = usages(message.role === 'assistant' ? message.usage : undefined, ...event.toolResults.map((r) => r.usage));
    stopIfOver(pi, live.session, ctx, recordTurn(live.context, live.session, turn).stop);
    return undefined;
  });

  pi.on('session_compact', async (event, ctx) => {
    const live = holder.live;
    if (live === undefined) return;
    stopIfOver(pi, live.session, ctx, recordTurn(live.context, live.session, usages(event.compactionEntry.usage)).stop);
  });

  pi.on('session_shutdown', async () => {
    const live = holder.live;
    holder.live = undefined;
    if (live === undefined) return;
    for (const unsubscribe of live.subscriptions.splice(0)) unsubscribe();
    closeSession(live.context, live.session);
    live.context.close();
  });
}
