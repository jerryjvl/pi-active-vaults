// Which queued spawns may start now (daemon.md "Scheduling", architecture.md
// "Scheduling"): in priority order — work another session waits on, a
// trigger's original work before the follow-ups it caused, earlier roots
// before later ones (`nextSpawns`) — as many as the model's capacity leaves
// room for, and one job per actor at a time.
//
// An actor is busy while a spawn of it runs, while one ahead of it in the
// queue is chosen, or while a session holds it (an interactive Pi session
// writing as that actor): its work waits, keeping its place. A spawn that
// names no actor can never run and is never chosen.

import { actorHold } from '../actors/index.ts';
import type { ProcessLiveness } from '../process/index.ts';
import type { Queryable } from '../store/index.ts';
import { listSpawns, nextSpawns, type SpawnEntry } from './spawns.ts';

/** How far down the queue a pass looks for work whose actor is free. */
const LOOK_AHEAD = 200;

/** The queued spawns to start now, in the order to start them. */
export async function schedulable(store: Queryable, alive: ProcessLiveness, capacity: number): Promise<SpawnEntry[]> {
  const running = listSpawns(store, { states: ['running'] });
  const room = capacity - running.length;
  if (room <= 0) return [];
  const busy = new Set(running.map((s) => `${s.vault}\0${s.actor ?? ''}`));
  const chosen: SpawnEntry[] = [];
  for (const spawn of nextSpawns(store, LOOK_AHEAD)) {
    if (chosen.length >= room) break;
    if (spawn.actor === undefined) continue;
    const key = `${spawn.vault}\0${spawn.actor}`;
    if (busy.has(key)) continue;
    busy.add(key); // whatever happens, nothing behind it runs as this actor in this pass
    if ((await actorHold(store, alive, spawn.vault, spawn.actor)) !== undefined) continue;
    chosen.push(spawn);
  }
  return chosen;
}
