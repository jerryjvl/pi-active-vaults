// The hold that keeps one writer per actor (concepts.md "Actor").
//
// A session holds its actor through a record of its process — ID and start
// time — and its session. The record counts only while that exact process
// runs, so a session that has ended, however it ended, holds nothing: there
// is nothing to unlock, and a dead holder's record is simply replaced.
//
// Invariants:
//  - taking a hold never waits: a busy actor is refused at once, naming the
//    session that holds it, so the session can wait or choose another actor;
//  - a holder whose state cannot be told still holds (fail closed: at most
//    one writer is the guarantee, not progress);
//  - a hold is replaced only if it is still the record that was found void,
//    so two sessions taking a free actor at once cannot both get it;
//  - a holder releases only its own hold.

import type { Clock } from '../clock/index.ts';
import type { ProcessLiveness } from '../process/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable, Store } from '../store/index.ts';

export interface Holder {
  readonly process: { readonly pid: number; readonly started: string };
  /** The Pi session (or headless run) writing as the actor. */
  readonly session: string;
}

export interface ActorHold {
  readonly vault: string;
  readonly actor: string;
  readonly holder: Holder;
  readonly since: string;
}

export type HoldError = { readonly reason: 'actor-busy'; readonly hold: ActorHold };

type Row = { vault: string; actor: string; pid: number; started: string; session: string; since: string };

const SELECT = 'SELECT vault, actor, pid, started, session, since FROM actors_holds';

function holdOf(row: Row): ActorHold {
  return { vault: row.vault, actor: row.actor, holder: { process: { pid: row.pid, started: row.started }, session: row.session }, since: row.since };
}

function sameHolder(a: Holder, b: Holder): boolean {
  return a.process.pid === b.process.pid && a.process.started === b.process.started && a.session === b.session;
}

/** Whether the recorded holder still runs; when that cannot be told, it is taken to. */
async function stands(hold: ActorHold, alive: ProcessLiveness): Promise<boolean> {
  const started = await alive(hold.holder.process.pid);
  return !started.ok || started.value === hold.holder.process.started;
}

function readRow(store: Queryable, vault: string, actor: string): Row | undefined {
  return store.get<Row>(`${SELECT} WHERE vault = ? AND actor = ?`, [vault, actor]);
}

/** The hold on an actor that stands, if any. */
export async function actorHold(store: Queryable, alive: ProcessLiveness, vault: string, actor: string): Promise<ActorHold | undefined> {
  const row = readRow(store, vault, actor);
  if (row === undefined) return undefined;
  const hold = holdOf(row);
  return (await stands(hold, alive)) ? hold : undefined;
}

/** Every hold that stands, by vault and actor. */
export async function listActorHolds(store: Queryable, alive: ProcessLiveness): Promise<ActorHold[]> {
  const holds: ActorHold[] = [];
  for (const row of store.all<Row>(`${SELECT} ORDER BY vault, actor`)) {
    if (await stands(holdOf(row), alive)) holds.push(holdOf(row));
  }
  return holds;
}

const MAX_ATTEMPTS = 3;

/** Takes the actor for `holder`, or says who holds it; taking a hold one already has is fine. */
export async function takeActorHold(
  store: Store, alive: ProcessLiveness, clock: Clock,
  request: { readonly vault: string; readonly actor: string; readonly holder: Holder },
): Promise<Result<ActorHold, HoldError>> {
  const { vault, actor, holder } = request;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const found = readRow(store, vault, actor);
    const current = found === undefined ? undefined : holdOf(found);
    if (current !== undefined && sameHolder(current.holder, holder)) return ok(current);
    if (current !== undefined && (await stands(current, alive))) return err({ reason: 'actor-busy', hold: current });

    const since = clock.now().toISOString();
    const taken = store.transaction((tx) => {
      const now = readRow(tx, vault, actor);
      const unchanged = now === undefined ? found === undefined : found !== undefined && now.pid === found.pid && now.started === found.started && now.session === found.session;
      if (!unchanged) return false;
      tx.run(
        `INSERT INTO actors_holds (vault, actor, pid, started, session, since) VALUES ($vault, $actor, $pid, $started, $session, $since)
         ON CONFLICT (vault, actor) DO UPDATE SET pid = excluded.pid, started = excluded.started, session = excluded.session, since = excluded.since`,
        { vault, actor, pid: holder.process.pid, started: holder.process.started, session: holder.session, since },
      );
      return true;
    });
    if (taken) return ok({ vault, actor, holder, since });
    // Someone else changed the record meanwhile: look again.
  }
  const now = readRow(store, vault, actor);
  if (now === undefined) throw new Error('an actor hold kept changing and then vanished');
  return err({ reason: 'actor-busy', hold: holdOf(now) });
}

/** Releases the hold if `holder` has it; true when it did. */
export function releaseActorHold(store: Store, request: { readonly vault: string; readonly actor: string; readonly holder: Holder }): boolean {
  const { vault, actor, holder } = request;
  const { changes } = store.run(
    'DELETE FROM actors_holds WHERE vault = ? AND actor = ? AND pid = ? AND started = ? AND session = ?',
    [vault, actor, holder.process.pid, holder.process.started, holder.session],
  );
  return changes > 0;
}
