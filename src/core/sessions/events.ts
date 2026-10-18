// Session events (concepts.md "applies-when", extension.md "Spawns"): what a
// session does — its start, each tool it uses, each path it touches — counted
// the first time, adding context and requesting the spawns it matches.
//
// A session event's identity is the session and what happened, so its spawn
// requests have a fixed identity before they are sent to the daemon or
// queued: one spawn, whatever happens to the reply. Spawned work joins the
// session's tree, under the session's trace.

import type { SpawnEntry, SpawnSender } from '../queue/index.ts';
import { matchSpawns, reachedVaults, submitSpawns } from '../queue/index.ts';
import { queueContext, spawnLines, spawnMatching, type OperationContext } from '../operations/index.ts';
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
  const key = `${event.kind}:${event.kind === 'session.path' ? `${event.vault}:` : ''}${id}`;
  if (session.seen.has(key)) return { fresh: false, ...NOTHING };
  session.seen.add(key);

  const injections = await injectionsFor(context, session, event);
  const { vaults, config } = context.installation;
  const targets = reachedVaults(vaults, config.subscriptions, event.kind === 'session.path' ? event.vault : undefined);
  const matched = await matchSpawns(await spawnMatching(context), { event, id }, targets, { parent: session.trace });
  if (!matched.ok) return { fresh: true, injections, spawns: [], notes: [`Its spawns could not be matched (${matched.error.reason}).`] };
  const spawns = await submitSpawns(context.state, queueContext(context), matched.value.requests, send);
  return { fresh: true, injections, spawns, notes: spawnLines([], matched.value) };
}
