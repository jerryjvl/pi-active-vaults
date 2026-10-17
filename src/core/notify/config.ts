// The installation config's `notify` section (notifications.md
// "Configuration"), validated by the module that uses it.
//
// Invariants:
//  - addresses exist only here, and each is a plain address — exactly one
//    `@`, ASCII, no spaces or separators — so nothing that reaches an envelope
//    or a header can carry a second recipient or a header of its own;
//  - recipients are named by alias, which is all a message ever gives;
//  - the password stays a secret reference, resolved only when sending;
//  - SMTP is port 465 (TLS from the start) or 587 (STARTTLS, required):
//    there is no unencrypted submission to configure;
//  - volume is always bounded: limits not given take the documented values.
// Problems name the field, never the value.

import { parseDuration } from '../clock/index.ts';
import { parseSecretRef, type SecretRef } from '../config/index.ts';
import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

export interface MailAddress {
  readonly name?: string;
  readonly address: string;
}

export type NotifyTransport =
  | {
      readonly type: 'smtp';
      readonly host: string;
      readonly port: 465 | 587;
      /** From the port: TLS from the start, or STARTTLS, required. */
      readonly security: 'tls' | 'starttls';
      readonly user: string;
      readonly password: SecretRef;
    }
  | { readonly type: 'sendmail'; readonly command: string; readonly args: readonly string[] };

export interface NotifyConfig {
  readonly from: MailAddress;
  /** Alias → address. */
  readonly recipients: Readonly<Record<string, string>>;
  readonly transport: NotifyTransport;
  readonly limits: { readonly perHour: number; readonly maxBytes: number; readonly cooldownMs: number };
}

const WHERE = 'notify';
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// One `@`, ASCII; no spaces, commas, semicolons, angle brackets, quotes or other separators.
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
// A display name: printable, without the characters that would end or quote it.
const NAMED_ADDRESS = /^([^<>"\\\x00-\x1f\x7f]*?)\s*<([^<>]*)>$/;
const HOST = /^[A-Za-z0-9.:-]+$/;
const DEFAULT_LIMITS = { perHour: 10, maxBytes: 200_000, cooldownMs: 12 * 3_600_000 };
const DEFAULT_SENDMAIL_ARGS = ['-t', '-i'];
const ADDRESS_PROBLEM = 'must be a plain address: one @, ASCII, no spaces or separators';

/** Whether `value` is an address the package will use: the only form envelopes and headers ever get. */
export function isPlainAddress(value: string): boolean {
  return ADDRESS.test(value);
}

function readFrom(r: DataReader, value: unknown, path: string): MailAddress {
  const text = r.string(value, path);
  if (text === '') return { address: '' };
  if (isPlainAddress(text)) return { address: text };
  const named = NAMED_ADDRESS.exec(text);
  const name = named?.[1]?.trim();
  const address = named?.[2] ?? '';
  if (named === null || !isPlainAddress(address)) {
    r.add(path, 'must be an address, or a name and an address in <>');
    return { address: '' };
  }
  return name === undefined || name === '' ? { address } : { name, address };
}

function readRecipients(r: DataReader, value: unknown, path: string): Record<string, string> {
  const section = r.record(value, path);
  if (typeof value === 'object' && value !== null && Object.keys(section).length === 0) r.add(path, 'must name at least one recipient');
  const recipients: Record<string, string> = {};
  for (const [alias, address] of Object.entries(section)) {
    const where = issuePath(path, alias);
    if (!ALIAS.test(alias)) r.add(where, 'must be an alias of letters, digits, ".", "_" or "-"');
    if (typeof address !== 'string' || !isPlainAddress(address)) r.add(where, ADDRESS_PROBLEM);
    else recipients[alias] = address;
  }
  return recipients;
}

function readTransport(r: DataReader, value: unknown, path: string): NotifyTransport {
  const type = r.oneOf(r.record(value, path)['type'], issuePath(path, 'type'), ['smtp', 'sendmail'] as const);
  // Nothing else can be checked for a transport of no known type; it is already an issue.
  if (type === undefined) return { type: 'sendmail', command: '', args: [] };
  if (type === 'sendmail') {
    const t = r.record(value, path, ['type', 'command', 'args']);
    const args = t['args'] === undefined ? DEFAULT_SENDMAIL_ARGS : r.stringList(t['args'], issuePath(path, 'args'));
    return { type, command: r.string(t['command'], issuePath(path, 'command')), args };
  }
  const t = r.record(value, path, ['type', 'host', 'port', 'user', 'password']);
  const port = t['port'] === 465 || t['port'] === 587 ? t['port'] : undefined;
  if (port === undefined) r.add(issuePath(path, 'port'), 'must be 465 (TLS) or 587 (STARTTLS)');
  const password = parseSecretRef(t['password'], issuePath(path, 'password'));
  if (!password.ok) r.issues.push(password.error);
  return {
    type,
    host: r.string(t['host'], issuePath(path, 'host'), HOST),
    port: port ?? 465,
    security: port === 587 ? 'starttls' : 'tls',
    user: r.string(t['user'], issuePath(path, 'user')),
    password: password.ok ? password.value : { kind: 'env', name: '_INVALID_', where: issuePath(path, 'password') },
  };
}

function readLimits(r: DataReader, value: unknown, path: string): NotifyConfig['limits'] {
  const l = r.record(value ?? {}, path, ['per-hour', 'max-bytes', 'cooldown']);
  const perHour = r.integer(l, 'per-hour', path, DEFAULT_LIMITS.perHour);
  const maxBytes = r.integer(l, 'max-bytes', path, DEFAULT_LIMITS.maxBytes);
  const cooldownMs = l['cooldown'] === undefined ? DEFAULT_LIMITS.cooldownMs : parseDuration(l['cooldown']);
  if (cooldownMs === undefined) r.add(issuePath(path, 'cooldown'), 'must be a duration such as 90s, 30m or 2h');
  return { perHour, maxBytes, cooldownMs: cooldownMs ?? DEFAULT_LIMITS.cooldownMs };
}

/** The `notify` section, or undefined when there is none (notifications are then not configured). */
export function parseNotifyConfig(value: unknown): Result<NotifyConfig | undefined, Issue[]> {
  const r = new DataReader();
  if (value === undefined) return r.result(undefined);
  const n = r.record(value, WHERE, ['from', 'recipients', 'transport', 'limits']);
  const config: NotifyConfig = {
    from: readFrom(r, n['from'], issuePath(WHERE, 'from')),
    recipients: readRecipients(r, n['recipients'], issuePath(WHERE, 'recipients')),
    transport: readTransport(r, n['transport'], issuePath(WHERE, 'transport')),
    limits: readLimits(r, n['limits'], issuePath(WHERE, 'limits')),
  };
  return r.result(config);
}
