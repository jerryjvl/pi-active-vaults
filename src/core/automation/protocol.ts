// The daemon's socket protocol (daemon.md "Socket protocol"): requests
// `{ id, method, params }` answered `{ id, ok, result }` or
// `{ id, ok: false, error }`, and notices for subscribers.
//
// | Method      | Params                                   | Result |
// |-------------|------------------------------------------|--------|
// | `ping`      | —                                        | `version`, `capabilities` (the methods) |
// | `spawn`     | a spawn request                          | the spawn as claimed |
// | `status`    | —                                        | queued and running spawns, paused vaults, the day's budget |
// | `subscribe` | `trace`, and optionally `session`/`file` | — then notices for the spawns in that session's tree |
// | `stop`      | `trace`                                  | — the running spawn is stopped on request |
//
// Requests are read strictly. A spawn request is only a request: it is
// claimed under its identity (document and event), but its budget and actor
// are the job's on the accepted main, whatever the request says, and it is
// refused unless the job's condition at the given position is a spawn
// condition the event matches — its script narrowing it, as anywhere — in a
// vault whose `main` has no unaccepted change.

import { EVENT_KINDS, matchConditions, narrowByScripts, type VaultEvent } from '../conditions/index.ts';
import { isTraceId } from '../ids/index.ts';
import { requireNoUnacceptedChange } from '../integrity/index.ts';
import { queueContext, type OperationContext } from '../operations/index.ts';
import { enqueueSpawn, scriptFilters, vaultJobs, type SpawnEntry, type SpawnEvent, type SpawnMatching } from '../queue/index.ts';
import { isRecord } from '../result/index.ts';

export const METHODS = ['ping', 'spawn', 'status', 'subscribe', 'stop'] as const;
export type Method = (typeof METHODS)[number];

export type Reply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly reason: string; readonly [detail: string]: unknown } };

export const answer = (result: unknown): Reply => ({ ok: true, result });
export const refuse = (reason: string, detail: Readonly<Record<string, unknown>> = {}): Reply => ({ ok: false, error: { reason, ...detail } });

/** A request read from the socket: its method and parameters, or why it cannot be one. */
export function readRequest(message: unknown): { method: Method; params: Readonly<Record<string, unknown>> } | Reply {
  if (!isRecord(message) || typeof message['method'] !== 'string') return refuse('invalid-request');
  const method = METHODS.find((m) => m === message['method']);
  if (method === undefined) return refuse('unknown-method', { method: message['method'] });
  const params = message['params'] ?? {};
  return isRecord(params) ? { method, params } : refuse('invalid-request');
}

const SPAWN_KEYS = ['vault', 'document', 'condition', 'event', 'parent', 'relevance', 'budget', 'actor'];

/** Claims what a spawn request asks for, as the job on the accepted main has it. */
export async function claimRequested(context: OperationContext, matching: SpawnMatching, params: Readonly<Record<string, unknown>>): Promise<Reply> {
  const { vault: vaultId, document, condition, event, parent, relevance } = params;
  const valid = Object.keys(params).every((k) => SPAWN_KEYS.includes(k))
    && typeof vaultId === 'string' && typeof document === 'string'
    && (condition === undefined || (typeof condition === 'number' && Number.isInteger(condition) && condition >= 0))
    && isRecord(event) && typeof event['kind'] === 'string' && (EVENT_KINDS as readonly string[]).includes(event['kind'])
    && (parent === undefined || (typeof parent === 'string' && isTraceId(parent)))
    && (relevance === undefined || (typeof relevance === 'number' && relevance >= 0 && relevance <= 1));
  if (!valid) return refuse('invalid-request');
  const vault = context.installation.vaults.find((v) => v.id === vaultId);
  if (vault === undefined) return refuse('unknown-vault', { vault: vaultId });
  const accepted = await requireNoUnacceptedChange(context.git, context.state, vault);
  if (!accepted.ok) return refuse(accepted.error.reason === 'unaccepted-change' ? 'unaccepted-change' : 'unreadable', { vault: vault.id });
  const jobs = await vaultJobs(context.git, vault.path, accepted.value, context.reads);
  const job = jobs.ok ? jobs.value.find((j) => j.path === document) : undefined;
  if (job === undefined || job.budget === undefined || job.actor === undefined) return refuse('not-a-job', { vault: vault.id, document });
  // Timers and manual runs are the daemon's and the CLI's own; a request names a condition the event matches.
  if (event['kind'] === 'timer' || condition === undefined) return refuse('not-matched');
  const asked = event as unknown as VaultEvent;
  const { config } = context.installation;
  const matched = matchConditions(asked, [{ vault: vault.id, document: job.path, conditions: job.conditions }], { subscriptions: config.subscriptions, equivalentLabels: config.labels.equivalent })
    .filter((m) => m.index === condition && m.condition.effect === 'spawn');
  const narrowed = await narrowByScripts(scriptFilters(matching), matching.scripts, asked, matched);
  if (narrowed.kept.length === 0) return refuse('not-matched');
  const { entry } = enqueueSpawn(context.state, queueContext(context), {
    vault: vault.id, document: job.path, condition, event: event as unknown as SpawnEvent, budget: job.budget, actor: job.actor,
    ...(typeof parent === 'string' ? { parent } : {}), ...(typeof relevance === 'number' ? { relevance } : {}),
  });
  return answer(entry);
}

/** What a notice says about a spawn starting or finishing. */
export interface Notice {
  readonly state: 'started' | 'finished';
  readonly trace: string;
  readonly vault: string;
  readonly document: string;
  readonly parent?: string;
  readonly root?: string;
  /** For a finished run: how it ended. */
  readonly outcome?: 'committed' | 'no-change' | 'stopped';
  readonly reason?: string;
  readonly commit?: string;
}

/** The notice for a spawn as recorded. */
export function noticeOf(state: Notice['state'], spawn: SpawnEntry): Notice {
  const outcome = spawn.commit !== undefined ? 'committed' : spawn.reason !== undefined ? 'stopped' : state === 'finished' ? 'no-change' : undefined;
  return {
    state, trace: spawn.trace, vault: spawn.vault, document: spawn.document,
    ...(spawn.parent === undefined ? {} : { parent: spawn.parent }), ...(spawn.root === undefined ? {} : { root: spawn.root }),
    ...(state === 'finished' && outcome !== undefined ? { outcome } : {}),
    ...(state === 'finished' && spawn.reason !== undefined ? { reason: spawn.reason } : {}),
    ...(spawn.commit === undefined ? {} : { commit: spawn.commit }),
  };
}

/** Whether a notice is about the tree of the session with `trace`. */
export function inTree(notice: Notice, trace: string): boolean {
  return notice.parent === trace || notice.root === trace;
}
