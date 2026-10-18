// Session events (concepts.md "applies-when", extension.md "Spawns"): what a
// session does — its start, each tool it uses, each path it touches — counted
// the first time, adding context and requesting the spawns it matches.
//
// A session event's identity is the session and what happened, so its spawn
// requests have a fixed identity before they are sent to the daemon or
// queued: one spawn, whatever happens to the reply. Spawned work joins the
// session's tree, under the session's trace.

import { spawnEventKey, type SpawnEntry, type SpawnSender } from '../queue/index.ts';
import { requestSpawns, spawnLines, type OperationContext } from '../operations/index.ts';
import { injectionsFor, type Injection, type SessionEvent } from './injection.ts';
import type { VaultSession } from './session.ts';

export interface SessionEventOutcome {
  /** False when the session had already done this; nothing else then happens. */
  readonly fresh: boolean;
  readonly injections: readonly Injection[];
  readonly spawns: readonly SpawnEntry[];
  /** What did not become a spawn, and why: paused vaults, scripts that said no. */
  readonly notes: readonly string[];
}

/** The event's ID within the session: one start, each tool once, each path once. */
function eventId(session: VaultSession, event: SessionEvent): string {
  switch (event.kind) {
    case 'session.start':
      return session.id;
    case 'session.tool':
      return `${session.id}/${event.tool}`;
    case 'session.path':
      return `${session.id}/${event.path}`;
  }
}

const NOTHING = { injections: [], spawns: [], notes: [] } as const;

/** Handles a session event the first time it happens: what it injects and what it spawns. */
export async function sessionEvent(context: OperationContext, session: VaultSession, event: SessionEvent, send?: SpawnSender): Promise<SessionEventOutcome> {
  const id = eventId(session, event);
  // The same key its spawns are claimed under: once seen, it has been matched.
  const key = spawnEventKey({ ...event, id });
  if (session.seen.has(key)) return { fresh: false, ...NOTHING };
  session.seen.add(key);
  if (event.kind === 'session.path') session.touched.add(event.vault);

  const injections = await injectionsFor(context, session, event);
  const requested = await requestSpawns(context, { event, id }, { parent: session.trace }, send);
  if (!requested.ok) return { fresh: true, injections, spawns: [], notes: [`Its spawns could not be matched (${requested.error.reason}).`] };
  return { fresh: true, injections, spawns: requested.value.entries, notes: spawnLines([], requested.value.matched) };
}
