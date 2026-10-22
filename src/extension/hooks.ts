// The session lifecycle (extension.md "Session lifecycle", api.md "Hooks"),
// adapted from Pi's events to the core's `sessions` module, which decides
// everything:
//
//  - session_start: load the installation, link to the daemon if one runs,
//    open the vault session (actor, holds, trace, budget — or, headless,
//    refuse and shut down), fix the catalog, subscribe to the notices of the
//    session's spawns, handle the start as a session event, publish `ready`;
//  - before_agent_start: the catalog as a prompt section, and whatever is
//    waiting for the model (start notices, a run's brief or else where the
//    session writes, start documents);
//  - tool_call: the write guard (blocking deliberately, with the reason), then
//    the tool and the paths it touches as session events;
//  - tool_result: the result in the trace's full log, taint, and the context
//    the call's paths brought in;
//  - turn_end and session_compact: the turn's work against the budget; a
//    headless run past its limits is stopped;
//  - session_shutdown: flush the trace and release everything, as often as
//    it is called.

import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import { newPrefixTracker, usageOf } from '../core/budgets/index.ts';
import { packageVersion, type Host } from '../core/config/index.ts';
import {
  callVaultPaths, createContext, describeError, loadInstallation, locate, operationNamed, type ContextOptions,
} from '../core/operations/index.ts';
import {
  catalogText, closeSession, describeWriting, guardToolCall, logToolResult, openSession, parseRunContext, recordTurn, renderInjections, sessionEvent, taints,
  type GuardedCall, type SessionEvent, type VaultSession,
} from '../core/sessions/index.ts';
import type { OperationContext } from '../core/operations/index.ts';
import { linkDaemon, type Notice } from '../core/automation/index.ts';
import { BUS_METHODS, subscribeRequests } from './bus.ts';
import { agentModelOf, workOf, type Holder, type Live } from './live.ts';
import { publishSpawns, CHANNEL_PREFIX } from './operate.ts';
import { readsOf, shellOf, writesOf } from './paths.ts';

export interface HookOptions {
  readonly host: () => Host;
  readonly pid: number;
  readonly context?: ContextOptions;
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
  // A daemon that runs takes the session's spawn requests; without one they are queued here.
  const link = await linkDaemon(installation.value.paths.socket);
  const made = createContext(installation.value, { ...options.context, ...(link === undefined ? {} : { send: link.send }) });
  if (!made.ok) {
    link?.close();
    return fail(holder, ctx, headless, `Vaults: the state database cannot be opened (${made.error.reason}).`);
  }
  const context = made.value;
  const release = (): void => {
    link?.close();
    context.close();
  };

  let run;
  if (headless) {
    let text: string;
    try {
      text = readFileSync(runFile, 'utf8');
    } catch {
      release();
      return fail(holder, ctx, true, `Vaults: the run file ${runFile} cannot be read; the run does not start.`);
    }
    const parsed = parseRunContext(text);
    if (!parsed.ok) {
      release();
      return fail(holder, ctx, true, `Vaults: the run file is not valid (${parsed.error.map((i) => `${i.path || 'file'}: ${i.message}`).join('; ')}); the run does not start.`);
    }
    run = parsed.value;
  }
  const opened = await openSession(context, {
    session: ctx.sessionManager.getSessionId(), pid: options.pid, cwd: ctx.cwd, ...modelOf(ctx),
    ...(typeof actor === 'string' && actor !== '' ? { actor } : {}), ...(run === undefined ? {} : { run }),
  });
  if (!opened.ok) {
    release();
    return fail(holder, ctx, true, `Vaults: the run does not start (${opened.error.reason}).`);
  }
  const { session, notices } = opened.value;
  const live: Live = { context, session, cwd: ctx.cwd, catalog: await catalogText(context), pending: [], forResult: new Map(), subscriptions: [], prefix: newPrefixTracker() };
  holder.live = live;
  holder.problem = undefined;
  for (const notice of notices) ctx.ui.notify(notice, 'warning');
  live.pending.push(...notices);
  // The model is told where it writes; a run's brief says so for its one worktree.
  live.pending.push(session.brief ?? (await describeWriting(context, session)));
  if (link !== undefined) {
    // Before the start's own spawns are requested, so their notices arrive too.
    const file = ctx.sessionManager.getSessionFile();
    await link.subscribe(session.trace, { id: session.id, ...(file === undefined ? {} : { file }) }, (notice) => tellSpawn(pi, ctx, notice));
    live.subscriptions.push(() => link.close());
  }
  live.pending.push(...(await handle(pi, live, { kind: 'session.start', ...modelOf(ctx) })));
  live.subscriptions.push(subscribeRequests(pi, holder));
  pi.events.emit(`${CHANNEL_PREFIX}:ready`, { version: packageVersion(), capabilities: [...BUS_METHODS], trace: session.trace });
}

/** A spawn of the session's starting or finishing: published, and a short notice to the person. */
function tellSpawn(pi: ExtensionAPI, ctx: ExtensionContext, notice: Notice): void {
  pi.events.emit(`${CHANNEL_PREFIX}:spawn`, {
    state: notice.state, trace: notice.trace, vault: notice.vault, document: notice.document,
    ...(notice.parent === undefined ? {} : { parent: notice.parent }), ...(notice.reason === undefined ? {} : { reason: notice.reason }),
  });
  const how = notice.outcome === undefined ? '' : ` (${notice.outcome}${notice.reason === undefined ? '' : `: ${notice.reason}`})`;
  ctx.ui.notify(`Vaults: spawned work ${notice.vault}:${notice.document} ${notice.state}${how}.`, 'info');
}

/** The Pi model the session runs on, as Pi names it (`provider/id`) — what `agent` models are configured by. */
const modelOf = (ctx: ExtensionContext): { model?: string } => (ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` });

/** Handles a session event: published, and what it injects and spawns, as text for the model. */
async function handle(pi: ExtensionAPI, live: Live, event: SessionEvent): Promise<string[]> {
  const outcome = await sessionEvent(live.context, live.session, event);
  if (!outcome.fresh) return [];
  pi.events.emit(`${CHANNEL_PREFIX}:event`, event);
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
  if (operation !== undefined) found.push(...callVaultPaths(vaults, operation, 'tool', event.input as Readonly<Record<string, unknown>>));
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
  pi.events.emit(`${CHANNEL_PREFIX}:spawn`, { state: 'stopped', reason: stop, trace: session.trace });
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
    logToolResult(live.context, live.session, {
      tool: event.toolName, input: event.input, isError: event.isError,
      text: event.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(''),
      ...(event.structuredContent === undefined ? {} : { data: event.structuredContent }),
    });
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
    // Tool results' usage (a fan-out's) arrives already counted as work.
    const own = message.role === 'assistant' && message.usage !== undefined ? [workOf(agentModelOf(live, ctx.model), live.prefix, message.usage)] : [];
    const turn = [...own, ...usages(...event.toolResults.map((r) => r.usage))];
    stopIfOver(pi, live.session, ctx, recordTurn(live.context, live.session, turn).stop);
    return undefined;
  });

  pi.on('session_compact', async (event, ctx) => {
    const live = holder.live;
    if (live === undefined) return;
    live.prefix.previous = 0; // the conversation starts again from its summary
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
