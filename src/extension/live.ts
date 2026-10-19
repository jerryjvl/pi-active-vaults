// What the extension holds while a Pi session runs: the operation context, the
// vault session, the catalog fixed at its start, and what is waiting to be
// added to the model's context. Made at `session_start`, released at
// `session_shutdown` (pi-conventions.md "Extension lifecycle"); between
// sessions there is nothing.

import type { Usage } from '@earendil-works/pi-ai';
import { assumePrefixCache, usageOf, type PrefixTracker, type RequestUsage } from '../core/budgets/index.ts';
import type { ModelEntry } from '../core/config/index.ts';
import type { OperationContext } from '../core/operations/index.ts';
import type { VaultSession } from '../core/sessions/index.ts';

export interface Live {
  readonly context: OperationContext;
  readonly session: VaultSession;
  /** Where the session started. */
  readonly cwd: string;
  /** The vault catalog for the system prompt: fixed for the session (principle 16). */
  readonly catalog: string;
  /** What the model is told with its next request: start notices, a run's brief, `session.start` documents. */
  readonly pending: string[];
  /** What is appended to a call's result: the context its paths brought in, and what it spawned. */
  readonly forResult: Map<string, string[]>;
  /** Event bus subscriptions to drop at shutdown. */
  readonly subscriptions: (() => void)[];
  /** The conversation's last prompt size, for a model that assumes a prefix cache. */
  readonly prefix: PrefixTracker;
}

/** The live session, or why there is none. */
export interface Holder {
  live?: Live | undefined;
  problem?: string | undefined;
}

/** The configured agent model a Pi model is, by the name Pi gives it (`provider/id`). */
export function agentModelOf(live: Live | undefined, model: { readonly provider: string; readonly id: string } | undefined): Extract<ModelEntry, { role: 'agent' }> | undefined {
  if (live === undefined || model === undefined) return undefined;
  const name = `${model.provider}/${model.id}`;
  for (const entry of Object.values(live.context.installation.config.models)) if (entry.role === 'agent' && entry.model === name) return entry;
  return undefined;
}

/** A request's usage as work, its prefix read assumed when its model is set to and the engine reported none. */
export function workOf(entry: Extract<ModelEntry, { role: 'agent' }> | undefined, conversation: PrefixTracker, usage: Usage): RequestUsage {
  if (entry?.assumePrefixCache !== true) return usageOf(usage);
  const { counts, assumed } = assumePrefixCache(conversation, usage);
  return { ...usageOf(counts), ...(assumed === 0 ? {} : { assumedPrefix: assumed }) };
}

/** The live session, or a problem to report as a tool or command result. */
export function liveOr(holder: Holder): { live: Live } | { problem: string } {
  return holder.live !== undefined ? { live: holder.live } : { problem: holder.problem ?? 'The vault extension has not started for this session.' };
}
