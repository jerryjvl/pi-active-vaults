// The spawn queue and its claims (daemon.md "Spawn lifecycle", architecture.md
// "Local storage" and "Scheduling").
//
// A spawn's identity is its document and the event that triggered it. Claiming
// composes, in one transaction: the unique insert that is the claim, a new
// trace ID, the `agent` model that answers the job's request, and the spawn's
// allotment from its session tree — so a crash leaves either no claim or a
// claimed spawn with its budget, never half of one. A spawn the tree refuses
// (no budget, too deep, already in the tree), or that no permitted `agent`
// model can run (`no-model`: none configured, or the policy does not allow it
// for the vault — never swapped for another), is still claimed, as stopped
// with the reason, so the same event never spawns it again. `matched` is not
// stored: matching is a pure function of history.
//
// Invariants: every later state change is one transaction that moves the
// spawn only from the state before it (queued → running → committed or
// no-change → recorded; queued or running → stopped → recorded), and ending a
// run ends its budget session, returning what it did not use to the tree's
// pool.

import {
  allot,
  finishSession,
  startSession,
  type AllotRefusal,
  type BudgetLimits,
} from '../budgets/index.ts';
import type { Clock } from '../clock/index.ts';
import type { GitEvent, VaultEvent } from '../conditions/index.ts';
import type { InstallationConfig } from '../config/index.ts';
import type { IdSource } from '../ids/index.ts';
import { resolveModel } from '../models/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Queryable, Store } from '../store/index.ts';
import { newTraceId } from '../traces/index.ts';
import type { SpawnTerms } from './jobs.ts';

export const queueSchema: ModuleSchema = {
  module: 'queue',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE queue_spawns (
        id INTEGER PRIMARY KEY,
        vault TEXT NOT NULL,
        document TEXT NOT NULL,
        event_key TEXT NOT NULL,
        condition INTEGER,
        event TEXT NOT NULL,
        trace TEXT NOT NULL UNIQUE,
        parent TEXT,
        root TEXT,
        depth INTEGER,
        tokens INTEGER,
        awaited INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        reason TEXT,
        commit_sha TEXT,
        claimed TEXT NOT NULL,
        started TEXT,
        ended TEXT,
        UNIQUE (vault, document, event_key)
      ) STRICT;
      CREATE INDEX queue_spawns_by_state ON queue_spawns (state);
      CREATE TABLE queue_cursors (
        vault TEXT NOT NULL,
        document TEXT NOT NULL,
        stream TEXT NOT NULL,
        position TEXT NOT NULL,
        updated TEXT NOT NULL,
        PRIMARY KEY (vault, document, stream)
      ) STRICT`,
    },
    {
      // Whom each spawn writes as, fixed at the claim (the job's actor on the
      // accepted main then), so the scheduler can run one job per actor.
      version: 2,
      sql: 'ALTER TABLE queue_spawns ADD COLUMN actor TEXT',
    },
    {
      // The daemon's own record (one row: the singleton) and the process of
      // each headless session it runs, for start-up recovery (runs.ts).
      version: 3,
      sql: `CREATE TABLE queue_daemon (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pid INTEGER NOT NULL,
        started TEXT NOT NULL,
        since TEXT NOT NULL
      ) STRICT;
      CREATE TABLE queue_runs (
        spawn INTEGER PRIMARY KEY REFERENCES queue_spawns (id),
        pid INTEGER NOT NULL,
        started TEXT NOT NULL
      ) STRICT`,
    },
    {
      // Where the installed service's tools were found on PATH, one row per
      // tool, for doctor to say when one has gone (runs.ts).
      version: 4,
      sql: `CREATE TABLE queue_service_tools (
        tool TEXT PRIMARY KEY,
        dir TEXT NOT NULL,
        recorded TEXT NOT NULL
      ) STRICT`,
    },
    {
      // The `agent` model each spawn runs on, by its configured name, fixed at
      // the claim (the job's model on the accepted main then).
      version: 5,
      sql: 'ALTER TABLE queue_spawns ADD COLUMN model TEXT',
    },
  ],
};

/** The event a spawn answers: a Git event, a timer firing, or another event with its own ID. */
export type SpawnEvent =
  | GitEvent
  | { readonly kind: 'timer'; readonly at: string }
  | (Exclude<VaultEvent, GitEvent> & { readonly id: string })
  /** `vault run`: a job run now, outside its conditions. */
  | { readonly kind: 'manual'; readonly id: string };

export type SpawnState = 'queued' | 'running' | 'committed' | 'no-change' | 'stopped' | 'recorded';

/**
 * Why a queued or running spawn stopped: over its budget or run time, queued
 * too long, an error, still running when the daemon restarted (start-up
 * recovery), stopped on request (the socket's `stop`), or a job that needs
 * its originating session without one to fork (`context: session-required`),
 * or without an `agent` model it may use (`no-model`). A spawn its session
 * tree refused at the claim carries the tree's reason instead.
 */
export type StopReason = 'budget' | 'ttl' | 'queue-time' | 'error' | 'restart' | 'requested' | 'no-session' | 'no-model';

/** A job's terms (its budget, its actor, the model name it asks for) and the event that spawns it. */
export interface SpawnRequest extends SpawnTerms {
  readonly vault: string;
  readonly document: string;
  /** The matching condition's position in the document; absent for a manual run. */
  readonly condition?: number;
  readonly event: SpawnEvent;
  /** The trace of the session whose work triggered this one. */
  readonly parent?: string;
  readonly relevance?: number;
}

export interface SpawnEntry {
  readonly id: number;
  readonly vault: string;
  readonly document: string;
  readonly condition?: number;
  readonly event: SpawnEvent;
  readonly trace: string;
  /** Whom it writes as; absent only for claims made before spawns recorded it. */
  readonly actor?: string;
  /** The `agent` model it runs on, by configured name; absent when none was usable (stopped `no-model`), and for claims made before spawns recorded it. */
  readonly model?: string;
  readonly parent?: string;
  /** Its place in the session tree; absent when the tree refused it. */
  readonly root?: string;
  readonly depth?: number;
  /** Tokens allotted. */
  readonly tokens?: number;
  readonly awaited: boolean;
  readonly state: SpawnState;
  /** Why it stopped. */
  readonly reason?: string;
  readonly commit?: string;
  readonly claimed: string;
  readonly started?: string;
  readonly ended?: string;
}

export type QueueError =
  | { readonly reason: 'not-found'; readonly id: number }
  | { readonly reason: 'wrong-state'; readonly id: number; readonly state: SpawnState };

export interface QueueContext {
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly limits: BudgetLimits;
  /** Which `agent` models exist and which vaults may use them. */
  readonly models: Pick<InstallationConfig, 'models' | 'policy'>;
}

interface SpawnRow {
  id: number;
  vault: string;
  document: string;
  condition: number | null;
  event: string;
  trace: string;
  actor: string | null;
  model: string | null;
  parent: string | null;
  root: string | null;
  depth: number | null;
  tokens: number | null;
  awaited: number;
  state: SpawnState;
  reason: string | null;
  commit_sha: string | null;
  claimed: string;
  started: string | null;
  ended: string | null;
}

const SELECT = 'SELECT id, vault, document, condition, event, trace, actor, model, parent, root, depth, tokens, awaited, state, reason, commit_sha, claimed, started, ended FROM queue_spawns';

/** The identity of the event within a spawn's identity. */
export function spawnEventKey(event: SpawnEvent): string {
  switch (event.kind) {
    case 'committed':
    case 'merged':
      // Each run's part of a Git event is its own identity, so one merge can continue several trees.
      return `${event.kind}:${event.vault}:${event.commit}${event.tree === undefined ? '' : `@${event.tree}`}`;
    case 'timer':
      return `timer:${event.at}`;
    default:
      return 'vault' in event ? `${event.kind}:${event.vault}:${event.id}` : `${event.kind}:${event.id}`;
  }
}

function present<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

function entryOf(row: SpawnRow): SpawnEntry {
  return {
    id: row.id,
    vault: row.vault,
    document: row.document,
    ...present('condition', row.condition),
    event: JSON.parse(row.event) as SpawnEvent,
    trace: row.trace,
    ...present('actor', row.actor),
    ...present('model', row.model),
    ...present('parent', row.parent),
    ...present('root', row.root),
    ...present('depth', row.depth),
    ...present('tokens', row.tokens),
    awaited: row.awaited !== 0,
    state: row.state,
    ...present('reason', row.reason),
    ...present('commit', row.commit_sha),
    claimed: row.claimed,
    ...present('started', row.started),
    ...present('ended', row.ended),
  };
}

function byId(tx: Queryable, id: number): SpawnEntry | undefined {
  const row = tx.get<SpawnRow>(`${SELECT} WHERE id = ?`, [id]);
  return row === undefined ? undefined : entryOf(row);
}

/**
 * Claims the spawn for `request`, or returns the existing claim for the same
 * document and event. A new claim is queued with its trace, its `agent` model
 * and its allotment, or stopped when no permitted model can run it or its
 * session tree refuses it.
 */
export function enqueueSpawn(store: Store, context: QueueContext, request: SpawnRequest): { entry: SpawnEntry; claimed: boolean } {
  const key = spawnEventKey(request.event);
  return store.transaction((tx) => {
    const existing = tx.get<SpawnRow>(`${SELECT} WHERE vault = ? AND document = ? AND event_key = ?`, [request.vault, request.document, key]);
    if (existing !== undefined) return { entry: entryOf(existing), claimed: false };

    const trace = newTraceId(context.ids);
    // Before the allotment: a spawn that cannot run is given no budget to return.
    const model = resolveModel(context.models, 'agent', [request.vault], request.model);
    const allotted = model.ok ? allot(tx, context.limits, context.clock, {
      trace,
      vault: request.vault,
      document: request.document,
      budget: request.budget,
      ...(request.parent === undefined ? {} : { parent: request.parent }),
      ...(request.relevance === undefined ? {} : { relevance: request.relevance }),
    }) : undefined;
    const refusal = !model.ok ? 'no-model' : allotted?.ok === false ? (allotted.error satisfies AllotRefusal).reason : undefined;
    const now = context.clock.now().toISOString();
    const placed = allotted?.ok === true ? allotted.value : undefined;
    const { lastInsertRowid } = tx.run(
      `INSERT INTO queue_spawns (vault, document, event_key, condition, event, trace, actor, model, parent, root, depth, tokens, state, reason, claimed, ended)
       VALUES ($vault, $document, $key, $condition, $event, $trace, $actor, $model, $parent, $root, $depth, $tokens, $state, $reason, $now, $ended)`,
      {
        vault: request.vault,
        document: request.document,
        key,
        condition: request.condition ?? null,
        event: JSON.stringify(request.event),
        trace,
        actor: request.actor,
        model: model.ok ? model.value.name : null,
        parent: request.parent ?? null,
        root: placed?.root ?? null,
        depth: placed?.depth ?? null,
        tokens: placed?.tokens ?? null,
        state: refusal === undefined ? 'queued' : 'stopped',
        reason: refusal ?? null,
        now,
        ended: refusal === undefined ? null : now,
      },
    );
    const entry = byId(tx, Number(lastInsertRowid));
    if (entry === undefined) throw new Error('a claimed spawn vanished');
    return { entry, claimed: true };
  });
}

/** Moves a spawn from one of `from` to `to` in one transaction, with what else that step changes. */
function advance(
  store: Store, id: number, from: readonly SpawnState[], to: SpawnState,
  step: (tx: Queryable, entry: SpawnEntry) => Readonly<Record<string, string | number | null>>,
): Result<SpawnEntry, QueueError> {
  return store.transaction((tx) => {
    const entry = byId(tx, id);
    if (entry === undefined) return err({ reason: 'not-found', id });
    if (!from.includes(entry.state)) return err({ reason: 'wrong-state', id, state: entry.state });
    const fields = step(tx, entry);
    const assignments = Object.keys(fields).map((column) => `, ${column} = $${column}`).join('');
    tx.run(`UPDATE queue_spawns SET state = $state${assignments} WHERE id = $id`, { ...fields, state: to, id });
    const updated = byId(tx, id);
    if (updated === undefined) throw new Error('an advanced spawn vanished');
    return ok(updated);
  });
}

/** Ends the run's budget session; a spawn the tree refused has none. */
function endSession(tx: Queryable, clock: Clock, entry: SpawnEntry): void {
  if (entry.root !== undefined) finishSession(tx, clock, entry.trace);
}

export function startSpawn(store: Store, clock: Clock, id: number): Result<SpawnEntry, QueueError> {
  return advance(store, id, ['queued'], 'running', (tx, entry) => {
    startSession(tx, clock, entry.trace);
    return { started: clock.now().toISOString() };
  });
}

export function commitSpawn(store: Store, clock: Clock, id: number, commit: string): Result<SpawnEntry, QueueError> {
  return advance(store, id, ['running'], 'committed', (tx, entry) => {
    endSession(tx, clock, entry);
    return { commit_sha: commit, ended: clock.now().toISOString() };
  });
}

/** The run ended without changes: the job decided there was nothing to do. */
export function noChangeSpawn(store: Store, clock: Clock, id: number): Result<SpawnEntry, QueueError> {
  return advance(store, id, ['running'], 'no-change', (tx, entry) => {
    endSession(tx, clock, entry);
    return { ended: clock.now().toISOString() };
  });
}

export function stopSpawn(store: Store, clock: Clock, id: number, reason: StopReason): Result<SpawnEntry, QueueError> {
  return advance(store, id, ['queued', 'running'], 'stopped', (tx, entry) => {
    endSession(tx, clock, entry);
    return { reason, ended: clock.now().toISOString() };
  });
}

/** Marks an ended spawn as recorded in its trace: its last state. */
export function recordSpawn(store: Store, id: number): Result<SpawnEntry, QueueError> {
  return advance(store, id, ['committed', 'no-change', 'stopped'], 'recorded', () => ({}));
}

/** Another session is waiting on this spawn's result, so it runs first. */
export function markAwaited(store: Store, id: number): Result<SpawnEntry, QueueError> {
  return advance(store, id, ['queued'], 'queued', () => ({ awaited: 1 }));
}

/** Queued spawns in the order they should run. */
export function nextSpawns(store: Queryable, limit: number): SpawnEntry[] {
  return store
    .all<SpawnRow>(`${SELECT} WHERE state = 'queued' ORDER BY awaited DESC, depth, root, id LIMIT ?`, [limit])
    .map(entryOf);
}

/** Stops every spawn queued longer than `maxQueueMs`, with the reason `queue-time`. */
export function expireQueued(store: Store, clock: Clock, maxQueueMs: number): SpawnEntry[] {
  const cutoff = new Date(clock.now().getTime() - maxQueueMs).toISOString();
  const stale = store.all<{ id: number }>("SELECT id FROM queue_spawns WHERE state = 'queued' AND claimed < ? ORDER BY id", [cutoff]);
  return stale.flatMap(({ id }) => {
    const stopped = stopSpawn(store, clock, id, 'queue-time');
    return stopped.ok ? [stopped.value] : [];
  });
}

/** Spawns in claim order, optionally only those of one vault or in some states. */
export function listSpawns(store: Queryable, filter: { readonly vault?: string; readonly states?: readonly SpawnState[] } = {}): SpawnEntry[] {
  return store
    .all<SpawnRow>(`${SELECT} ORDER BY id`)
    .filter((row) => (filter.vault === undefined || row.vault === filter.vault) && (filter.states === undefined || filter.states.includes(row.state)))
    .map(entryOf);
}
