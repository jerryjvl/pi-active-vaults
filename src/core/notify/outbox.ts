// The notification outbox in `state.sqlite` (notifications.md "Guarantees"):
// every message is recorded here before it is sent, and marked sent only once
// the transport accepted it, so nothing is lost when sending fails.
//
// Invariants:
//  - queueing is one transaction that applies the key's cooldown and the
//    per-hour limit and records the message, so two senders at once cannot
//    both slip under a limit;
//  - a message keeps its Message-ID for life — derived from its trace, its key
//    and how many messages of that trace and key came before — so a retry is
//    recognisably the same message, and a later message is not;
//  - only the alias is stored, never the address (it is looked up when
//    sending) and never a credential;
//  - failures are retried with growing backoff, never given up on, except a
//    message whose alias no longer exists, which is undeliverable.

import { createHash } from 'node:crypto';
import type { Clock } from '../clock/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Queryable, Store } from '../store/index.ts';

export const notifySchema: ModuleSchema = {
  module: 'notify',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE notify_outbox (
        id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        trace TEXT NOT NULL,
        alias TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        key TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'undeliverable')),
        created TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt TEXT,
        last_error TEXT,
        sent TEXT
      ) STRICT;
      CREATE INDEX notify_outbox_due ON notify_outbox (state, next_attempt);
      CREATE INDEX notify_outbox_created ON notify_outbox (created)`,
    },
  ],
};

export interface OutboxEntry {
  readonly id: number;
  readonly messageId: string;
  readonly trace: string;
  readonly alias: string;
  readonly subject: string;
  readonly body: string;
  readonly created: string;
}

/** An undelivered message as `vault status` and `vault doctor` show it: no address, no body. */
export interface UndeliveredNotification {
  readonly alias: string;
  readonly subject: string;
  readonly messageId: string;
  readonly state: 'pending' | 'undeliverable';
  readonly attempts: number;
  readonly lastError?: string;
  readonly nextAttempt?: string;
}

export type QueueRefusal =
  | { readonly reason: 'duplicate'; readonly messageId: string }
  | { readonly reason: 'rate-limited'; readonly perHour: number };

const HOUR_MS = 3_600_000;
// After the first failed attempt, the second, …; the last repeats.
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * HOUR_MS, 6 * HOUR_MS];

function messageIdFor(trace: string, key: string | undefined, ordinal: number, domain: string): string {
  const derived = createHash('sha256').update(`${key ?? ''}#${ordinal}`).digest('hex').slice(0, 16);
  return `<${trace}.${derived}@${domain}>`;
}

type Row = { id: number; message_id: string; trace: string; alias: string; subject: string; body: string; created: string };

const entryOf = (row: Row): OutboxEntry => ({
  id: row.id, messageId: row.message_id, trace: row.trace, alias: row.alias, subject: row.subject, body: row.body, created: row.created,
});

/** Records a message as pending, unless its key is in cooldown or the hour's limit is reached. */
export function queueMessage(
  store: Store, clock: Clock,
  message: { readonly trace: string; readonly alias: string; readonly subject: string; readonly body: string; readonly key?: string; readonly domain: string },
  limits: { readonly perHour: number; readonly cooldownMs: number },
): Result<OutboxEntry, QueueRefusal> {
  const now = clock.now();
  return store.transaction((tx) => {
    if (message.key !== undefined) {
      const since = new Date(now.getTime() - limits.cooldownMs).toISOString();
      const recent = tx.get<{ message_id: string }>('SELECT message_id FROM notify_outbox WHERE key = ? AND created > ? ORDER BY id DESC LIMIT 1', [message.key, since]);
      if (recent !== undefined) return err({ reason: 'duplicate', messageId: recent.message_id });
    }
    const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
    const lastHour = tx.get<{ n: number }>('SELECT count(*) AS n FROM notify_outbox WHERE created > ?', [hourAgo])?.n ?? 0;
    if (lastHour >= limits.perHour) return err({ reason: 'rate-limited', perHour: limits.perHour });
    const before = tx.get<{ n: number }>('SELECT count(*) AS n FROM notify_outbox WHERE trace = ? AND key IS ?', [message.trace, message.key ?? null])?.n ?? 0;
    const messageId = messageIdFor(message.trace, message.key, before + 1, message.domain);
    const created = now.toISOString();
    const { lastInsertRowid } = tx.run(
      `INSERT INTO notify_outbox (message_id, trace, alias, subject, body, key, state, created, next_attempt)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [messageId, message.trace, message.alias, message.subject, message.body, message.key ?? null, created, created],
    );
    return ok({ id: Number(lastInsertRowid), messageId, trace: message.trace, alias: message.alias, subject: message.subject, body: message.body, created });
  });
}

/** Pending messages whose next attempt is due, oldest first. */
export function dueMessages(store: Queryable, clock: Clock): OutboxEntry[] {
  return store
    .all<Row>("SELECT id, message_id, trace, alias, subject, body, created FROM notify_outbox WHERE state = 'pending' AND next_attempt <= ? ORDER BY id", [clock.now().toISOString()])
    .map(entryOf);
}

export function markSent(store: Store, clock: Clock, id: number): void {
  store.run("UPDATE notify_outbox SET state = 'sent', sent = ?, attempts = attempts + 1, next_attempt = NULL, last_error = NULL WHERE id = ? AND state = 'pending'", [clock.now().toISOString(), id]);
}

/** Records a failed attempt: retried after the backoff for its number of attempts, or never when undeliverable. */
export function markFailed(store: Store, clock: Clock, id: number, failure: { readonly reason: string; readonly retry: boolean }): void {
  store.transaction((tx) => {
    const row = tx.get<{ attempts: number }>("SELECT attempts FROM notify_outbox WHERE id = ? AND state = 'pending'", [id]);
    if (row === undefined) return;
    const attempts = row.attempts + 1;
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? HOUR_MS;
    const next = failure.retry ? new Date(clock.now().getTime() + delay).toISOString() : null;
    tx.run(
      'UPDATE notify_outbox SET attempts = ?, last_error = ?, next_attempt = ?, state = ? WHERE id = ?',
      [attempts, failure.reason, next, failure.retry ? 'pending' : 'undeliverable', id],
    );
  });
}

export function undeliveredNotifications(store: Queryable): UndeliveredNotification[] {
  return store
    .all<{ alias: string; subject: string; message_id: string; state: 'pending' | 'undeliverable'; attempts: number; last_error: string | null; next_attempt: string | null }>(
      "SELECT alias, subject, message_id, state, attempts, last_error, next_attempt FROM notify_outbox WHERE state != 'sent' ORDER BY id",
    )
    .map((row) => ({
      alias: row.alias, subject: row.subject, messageId: row.message_id, state: row.state, attempts: row.attempts,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.next_attempt === null ? {} : { nextAttempt: row.next_attempt }),
    }));
}
