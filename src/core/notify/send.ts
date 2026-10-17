// Sending a notification (notifications.md): validate, record in the outbox,
// deliver, and say what happened — the record a run's trace keeps.
//
// Invariants:
//  - a recipient is an alias from the configuration; anything that looks like
//    an address is refused outright, so no input can name a recipient;
//  - a subject loses its line breaks (and other control characters), so it
//    stays one header; a body is plain UTF-8 text within the size limit;
//  - the message is in the outbox before delivery is tried, and the address is
//    looked up only at delivery, from the configuration as it is then;
//  - what is returned — alias, subject, Message-ID, outcome — holds no address
//    and no credential.
//
// A transport test (`vault notify test`) is the one send that skips the
// outbox: it delivers one fixed message to an alias at once and reports why
// it failed, since a test that queued and retried would answer nothing.

import { err, ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import type { NotifyConfig } from './config.ts';
import { dueMessages, markFailed, markSent, queueMessage, type OutboxEntry } from './outbox.ts';
import { deliver, type TransportDeps } from './transport.ts';

export interface NotifyDeps extends TransportDeps {
  readonly store: Store;
  readonly config: NotifyConfig;
}

export interface NotificationRequest {
  /** An alias from the configuration. */
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Deduplication: a second message with this key inside the cooldown is dropped. */
  readonly key?: string;
  /** The run sending it. */
  readonly trace: string;
}

/** What a run's trace records about a send. */
export interface NotificationRecord {
  readonly alias: string;
  readonly subject: string;
  readonly messageId: string;
  /** `queued`: delivery failed and will be retried; `undeliverable`: its alias is gone. */
  readonly outcome: 'sent' | 'queued' | 'duplicate' | 'undeliverable';
}

export type NotifyError =
  | { readonly reason: 'raw-address' }
  | { readonly reason: 'unknown-recipient'; readonly alias: string }
  | { readonly reason: 'empty-subject' }
  | { readonly reason: 'too-large'; readonly maxBytes: number }
  | { readonly reason: 'rate-limited'; readonly perHour: number };

/** One header line: line breaks become spaces, other control characters go. */
function oneLine(subject: string): string {
  return subject.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/ {2,}/g, ' ').trim();
}

function domainOf(address: string): string {
  return address.slice(address.indexOf('@') + 1);
}

async function attempt(deps: NotifyDeps, entry: OutboxEntry): Promise<NotificationRecord> {
  const record = { alias: entry.alias, subject: entry.subject, messageId: entry.messageId };
  const address = recipient(deps.config, entry.alias);
  if (!address.ok) {
    markFailed(deps.store, deps.clock, entry.id, { reason: 'unknown-recipient', retry: false });
    return { ...record, outcome: 'undeliverable' };
  }
  const delivered = await deliver(deps.config.transport, deps, {
    from: deps.config.from, to: address.value, subject: entry.subject, body: entry.body, messageId: entry.messageId, date: new Date(entry.created),
  });
  if (delivered.ok) {
    markSent(deps.store, deps.clock, entry.id);
    return { ...record, outcome: 'sent' };
  }
  markFailed(deps.store, deps.clock, entry.id, delivered.error);
  return { ...record, outcome: 'queued' };
}

/** The address an alias stands for; any address-like input is refused, never looked up. */
function recipient(config: NotifyConfig, alias: string): Result<string, NotifyError> {
  if (alias.includes('@')) return err({ reason: 'raw-address' });
  const address = Object.hasOwn(config.recipients, alias) ? config.recipients[alias] : undefined;
  return address === undefined ? err({ reason: 'unknown-recipient', alias }) : ok(address);
}

export async function sendNotification(deps: NotifyDeps, request: NotificationRequest): Promise<Result<NotificationRecord, NotifyError>> {
  const { config } = deps;
  const address = recipient(config, request.to);
  if (!address.ok) return address;
  const subject = oneLine(request.subject);
  if (subject === '') return err({ reason: 'empty-subject' });
  if (Buffer.byteLength(request.body, 'utf8') > config.limits.maxBytes) return err({ reason: 'too-large', maxBytes: config.limits.maxBytes });

  const queued = queueMessage(deps.store, deps.clock, {
    trace: request.trace, alias: request.to, subject, body: request.body, domain: domainOf(config.from.address),
    ...(request.key === undefined ? {} : { key: request.key }),
  }, config.limits);
  if (!queued.ok) {
    return queued.error.reason === 'duplicate'
      ? ok({ alias: request.to, subject, messageId: queued.error.messageId, outcome: 'duplicate' })
      : err(queued.error);
  }
  return ok(await attempt(deps, queued.value));
}

/** Delivers one test message to `alias` now, outside the outbox. */
export async function testTransport(deps: NotifyDeps, alias: string): Promise<Result<void, NotifyError | { readonly reason: 'delivery-failed'; readonly failure: string }>> {
  const address = recipient(deps.config, alias);
  if (!address.ok) return address;
  const now = deps.clock.now();
  const delivered = await deliver(deps.config.transport, deps, {
    from: deps.config.from,
    to: address.value,
    subject: 'Test notification from pi-active-vaults',
    body: 'This message tests the notification transport. Nothing needs to be done.\n',
    messageId: `<test.${now.getTime()}@${domainOf(deps.config.from.address)}>`,
    date: now,
  });
  return delivered.ok ? ok(undefined) : err({ reason: 'delivery-failed', failure: delivered.error.reason });
}

/** Retries every message whose next attempt is due (the daemon's outbox), oldest first. */
export async function deliverDue(deps: NotifyDeps): Promise<NotificationRecord[]> {
  const records: NotificationRecord[] = [];
  for (const entry of dueMessages(deps.store, deps.clock)) records.push(await attempt(deps, entry));
  return records;
}
