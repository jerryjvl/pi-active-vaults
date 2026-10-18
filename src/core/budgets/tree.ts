// Budgets down a session tree (concepts.md "Session tree", principle 7).
//
// A root session gets its document's budget, and its tree a cascade pool. A
// spawned session gets the smaller of its document's budget and
//   the pool's remaining tokens × depth-decay^depth × relevance,
// so allotments only shrink as work branches. What is allotted is reserved:
// until a session finishes it holds the larger of its allotment and its use,
// and afterwards only its use, so concurrent siblings cannot overdraw the pool
// and unused tokens return to it. The installation's daily ceiling caps every
// allotment and every day's accounting, in UTC days.
//
// Invariants: no document fires twice in one tree — a unique index, so a
// second allotment fails inside the database — and nothing deeper than
// max-depth is allotted. Allotting reads then writes, so it must run inside
// the caller's transaction (`store.transaction`), which also lets the queue
// claim a spawn and allot its budget atomically. A tree without a configured
// pool is bounded by its documents' budgets, max-depth, once-per-tree and the
// daily ceiling.

import { utcDay, type Clock } from '../clock/index.ts';
import type { InstallationConfig } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Queryable } from '../store/index.ts';
import { workTokens, type Budget, type RequestUsage } from './budget.ts';

export const budgetsSchema: ModuleSchema = {
  module: 'budgets',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE budgets_sessions (
        trace TEXT PRIMARY KEY,
        root TEXT NOT NULL,
        parent TEXT,
        depth INTEGER NOT NULL,
        vault TEXT,
        document TEXT,
        pool INTEGER,
        allotted INTEGER NOT NULL,
        ttl_ms INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        started TEXT,
        finished TEXT
      ) STRICT;
      CREATE UNIQUE INDEX budgets_sessions_once ON budgets_sessions (root, vault, document);
      CREATE TABLE budgets_daily (day TEXT PRIMARY KEY, used INTEGER NOT NULL) STRICT`,
    },
  ],
};

export type BudgetLimits = InstallationConfig['budgets'];

export interface AllotRequest {
  /** The session's trace ID. */
  readonly trace: string;
  /** The trace of the session that spawned it; absent for a root. */
  readonly parent?: string;
  /** The document that runs; absent for an interactive session. */
  readonly vault?: string;
  readonly document?: string;
  readonly budget: Budget;
  /** The trigger's relevance score, from 0 to 1; 1 when it has none. */
  readonly relevance?: number;
}

export interface Allotment {
  readonly trace: string;
  readonly root: string;
  readonly depth: number;
  readonly tokens: number;
  readonly ttlMs: number;
}

export type AllotRefusal =
  | { readonly reason: 'daily-exhausted' }
  | { readonly reason: 'pool-exhausted' }
  | { readonly reason: 'too-deep'; readonly depth: number; readonly maxDepth: number }
  | { readonly reason: 'already-in-tree'; readonly vault: string; readonly document: string }
  | { readonly reason: 'unknown-parent'; readonly parent: string };

export type SessionError = { readonly reason: 'unknown-session' | 'finished'; readonly trace: string };

export interface BudgetState {
  readonly allotted: number;
  readonly used: number;
  readonly remaining: number;
  /** The session has used its allotment. */
  readonly exhausted: boolean;
  /** Today's work across the installation has reached the daily ceiling. */
  readonly dailyExhausted: boolean;
  /** When the run must end (ISO 8601); absent until it starts. */
  readonly deadline?: string;
  readonly overTime: boolean;
}

interface SessionRow {
  trace: string;
  root: string;
  depth: number;
  pool: number | null;
  allotted: number;
  ttl_ms: number;
  used: number;
  started: string | null;
  finished: string | null;
}

const SESSION_COLUMNS = 'trace, root, depth, pool, allotted, ttl_ms, used, started, finished';

function session(tx: Queryable, trace: string): SessionRow | undefined {
  return tx.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM budgets_sessions WHERE trace = ?`, [trace]);
}

/** Work counted across the installation today (UTC). */
export function usedToday(tx: Queryable, clock: Clock): number {
  return tx.get<{ used: number }>('SELECT used FROM budgets_daily WHERE day = ?', [utcDay(clock.now())])?.used ?? 0;
}

/** The root's pool less what its tree holds: the larger of allotment and use until finished, then use. */
function poolRemaining(tx: Queryable, root: SessionRow): number {
  if (root.pool === null) return Infinity;
  const held = tx.get<{ held: number }>(
    `SELECT COALESCE(SUM(CASE WHEN finished IS NULL THEN MAX(allotted, used) ELSE used END), 0) AS held
     FROM budgets_sessions WHERE root = ? AND depth > 0`,
    [root.trace],
  )?.held ?? 0;
  return Math.max(0, root.pool - held);
}

/** Allots a session's budget and records it in its tree; call inside a transaction. */
export function allot(tx: Queryable, limits: BudgetLimits, clock: Clock, request: AllotRequest): Result<Allotment, AllotRefusal> {
  const relevance = request.relevance ?? 1;
  if (!(relevance >= 0 && relevance <= 1)) throw new RangeError('relevance must be between 0 and 1');
  const dailyLeft = limits.dailyTokens === undefined ? Infinity : limits.dailyTokens - usedToday(tx, clock);
  if (dailyLeft <= 0) return err({ reason: 'daily-exhausted' });

  let root = request.trace;
  let depth = 0;
  let share = Infinity;
  if (request.parent !== undefined) {
    const parent = session(tx, request.parent);
    if (parent === undefined) return err({ reason: 'unknown-parent', parent: request.parent });
    root = parent.root;
    depth = parent.depth + 1;
    if (depth > limits.maxDepth) return err({ reason: 'too-deep', depth, maxDepth: limits.maxDepth });
    const rootRow = session(tx, root);
    if (rootRow === undefined) throw new Error('a session tree lost its root');
    share = Math.floor(poolRemaining(tx, rootRow) * limits.depthDecay ** depth * relevance);
  }
  if (request.vault !== undefined && request.document !== undefined) {
    const fired = tx.get('SELECT 1 FROM budgets_sessions WHERE root = ? AND vault = ? AND document = ?', [root, request.vault, request.document]);
    if (fired !== undefined) return err({ reason: 'already-in-tree', vault: request.vault, document: request.document });
  }
  const tokens = Math.min(request.budget.tokens, share, dailyLeft);
  if (tokens < 1) return err({ reason: 'pool-exhausted' });

  tx.run(
    `INSERT INTO budgets_sessions (trace, root, parent, depth, vault, document, pool, allotted, ttl_ms)
     VALUES ($trace, $root, $parent, $depth, $vault, $document, $pool, $allotted, $ttl)`,
    {
      trace: request.trace,
      root,
      parent: request.parent ?? null,
      depth,
      vault: request.vault ?? null,
      document: request.document ?? null,
      pool: depth === 0 ? limits.cascadePool ?? null : null,
      allotted: tokens,
      ttl: request.budget.ttlMs,
    },
  );
  return ok({ trace: request.trace, root, depth, tokens, ttlMs: request.budget.ttlMs });
}

function liveSession(tx: Queryable, trace: string): Result<SessionRow, SessionError> {
  const row = session(tx, trace);
  if (row === undefined) return err({ reason: 'unknown-session', trace });
  return row.finished === null ? ok(row) : err({ reason: 'finished', trace });
}

/** Marks the start of the run: its ttl counts from here. Starting twice keeps the first start. */
export function startSession(tx: Queryable, clock: Clock, trace: string): Result<void, SessionError> {
  const row = liveSession(tx, trace);
  if (!row.ok) return row;
  tx.run('UPDATE budgets_sessions SET started = COALESCE(started, ?) WHERE trace = ?', [clock.now().toISOString(), trace]);
  return ok(undefined);
}

/** Ends the session: what it did not use returns to its tree's pool. */
export function finishSession(tx: Queryable, clock: Clock, trace: string): Result<void, SessionError> {
  const row = liveSession(tx, trace);
  if (!row.ok) return row;
  tx.run('UPDATE budgets_sessions SET finished = ? WHERE trace = ?', [clock.now().toISOString(), trace]);
  return ok(undefined);
}

function stateOf(row: SessionRow, limits: BudgetLimits, clock: Clock, today: number): BudgetState {
  const deadline = row.started === null ? undefined : new Date(Date.parse(row.started) + row.ttl_ms);
  return {
    allotted: row.allotted,
    used: row.used,
    remaining: Math.max(0, row.allotted - row.used),
    exhausted: row.used >= row.allotted,
    dailyExhausted: limits.dailyTokens !== undefined && today >= limits.dailyTokens,
    ...(deadline === undefined ? {} : { deadline: deadline.toISOString() }),
    overTime: deadline !== undefined && clock.now().getTime() > deadline.getTime(),
  };
}

/** Counts one request's work against the session and the day; the state says whether a limit is reached. */
export function accountUsage(tx: Queryable, limits: BudgetLimits, clock: Clock, trace: string, usage: RequestUsage): Result<BudgetState, SessionError> {
  const row = liveSession(tx, trace);
  if (!row.ok) return row;
  const tokens = workTokens(usage);
  tx.run('UPDATE budgets_sessions SET used = used + ? WHERE trace = ?', [tokens, trace]);
  tx.run('INSERT INTO budgets_daily (day, used) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET used = used + excluded.used', [utcDay(clock.now()), tokens]);
  return ok(stateOf({ ...row.value, used: row.value.used + tokens }, limits, clock, usedToday(tx, clock)));
}

/** The session's budget now, or undefined for an unknown session. */
export function budgetState(store: Queryable, limits: BudgetLimits, clock: Clock, trace: string): BudgetState | undefined {
  const row = session(store, trace);
  return row === undefined ? undefined : stateOf(row, limits, clock, usedToday(store, clock));
}

/** The traces of the sessions that led to `trace`, root first — its causal path; empty for a root or an unknown session. */
export function treePath(store: Queryable, trace: string): string[] {
  const path: string[] = [];
  let parent = store.get<{ parent: string | null }>('SELECT parent FROM budgets_sessions WHERE trace = ?', [trace])?.parent ?? null;
  // Parents are recorded before their children, so there is no cycle; a damaged ledger still cannot loop.
  while (parent !== null && !path.includes(parent)) {
    path.unshift(parent);
    parent = store.get<{ parent: string | null }>('SELECT parent FROM budgets_sessions WHERE trace = ?', [parent])?.parent ?? null;
  }
  return path;
}

/** Whether `trace` is a session in this installation's ledger: a tree work can continue here. */
export function hasSession(store: Queryable, trace: string): boolean {
  return store.get('SELECT 1 FROM budgets_sessions WHERE trace = ?', [trace]) !== undefined;
}
