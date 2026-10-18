// Job cursors (architecture.md "Change-triggered work", daemon.md
// "Matching"): how far each job has handled each stream of events — Git
// events from one source vault, or one timer condition. Events are derived
// from the cursor up to the accepted `main`, so nothing is lost while no
// daemon runs.
//
// Invariant: advancing is one compare-and-swap statement, so of two processes
// handling the same events only one moves the cursor; the other learns where
// it is. Taking a `Queryable` lets the caller advance in the same transaction
// as the claims for those events.

import type { Clock } from '../clock/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';

export interface CursorKey {
  readonly vault: string;
  readonly document: string;
  readonly stream: string;
}

export type CursorError = { readonly reason: 'cursor-moved'; readonly current: string | null };

/** The stream of `committed` or `merged` events from `source`. */
export function gitStream(kind: 'committed' | 'merged', source: string): string {
  return `${kind}:${source}`;
}

/** The stream of a timer condition, by its position in the document. */
export function timerStream(condition: number): string {
  return `timer:${condition}`;
}

export function readCursor(store: Queryable, key: CursorKey): string | undefined {
  return store.get<{ position: string }>(
    'SELECT position FROM queue_cursors WHERE vault = ? AND document = ? AND stream = ?',
    [key.vault, key.document, key.stream],
  )?.position;
}

/** Moves the cursor from `expected` (null: not yet set) to `next`, unless it is no longer at `expected`. */
export function advanceCursor(store: Queryable, clock: Clock, key: CursorKey, expected: string | null, next: string): Result<void, CursorError> {
  const params = { ...key, next, now: clock.now().toISOString() };
  const { changes } = expected === null
    ? store.run(
      `INSERT INTO queue_cursors (vault, document, stream, position, updated) VALUES ($vault, $document, $stream, $next, $now)
       ON CONFLICT DO NOTHING`, params)
    : store.run(
      `UPDATE queue_cursors SET position = $next, updated = $now
       WHERE vault = $vault AND document = $document AND stream = $stream AND position = $expected`, { ...params, expected });
  return changes === 1 ? ok(undefined) : err({ reason: 'cursor-moved', current: readCursor(store, key) ?? null });
}
