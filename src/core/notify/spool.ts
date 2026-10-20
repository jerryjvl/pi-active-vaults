// Notification spools (notifications.md "Spools"): a drop directory per
// recipient alias, through which a less privileged process — one that may not
// read the installation's config or secrets — asks for a notification. The
// daemon reads each message, sends it through the outbox like any other, and
// removes it.
//
// Invariants:
//  - the recipient is the directory's alias and nothing else: a message names
//    no recipient, so one that can write to a spool can reach exactly one alias;
//  - a message is checked like any other (one-line subject, size limit) and
//    more besides: UTF-8, known headers only, a regular file. One that fails is
//    renamed `.rejected-<name>` — kept for the owner to see, never retried;
//  - names starting with "." are not messages: a writer creates one there and
//    renames it into place, so a message is never read half-written;
//  - a spool may use at most half the hour's notifications (`spoolAllowance`),
//    so a busy one cannot starve the vaults' own; a message over that, or over
//    the hour's limit, stays where it is and is tried on the next pass;
//    everything else that is sent, queued or a duplicate is removed once the
//    outbox has it.

import { lstat, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';
import { markdownEmail } from './markdown.ts';
import { sendNotification, type NotificationRecord, type NotifyDeps } from './send.ts';

export const REJECTED_PREFIX = '.rejected-';
const HEADERS = ['subject', 'key', 'format'] as const;
const KEY = /^[A-Za-z0-9._:-]{1,120}$/;

export interface SpoolMessage {
  readonly subject: string;
  readonly key?: string;
  readonly format: 'plain' | 'markdown';
  readonly body: string;
}

/** Parses a spool message: header lines, a blank line, then the body. */
export function parseSpoolMessage(text: string): Result<SpoolMessage, string> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headers = new Map<string, string>();
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '') break;
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m === null) return err(`line ${i + 1} is not a header ("Name: value") and no blank line came before it`);
    const name = (m[1] ?? '').toLowerCase();
    if (!(HEADERS as readonly string[]).includes(name)) return err(`unknown header "${m[1]}" (known: Subject, Key, Format)`);
    if (headers.has(name)) return err(`header "${m[1]}" is given twice`);
    headers.set(name, (m[2] ?? '').trim());
  }
  const subject = headers.get('subject');
  if (subject === undefined || subject === '') return err('no Subject header');
  const key = headers.get('key');
  if (key !== undefined && !KEY.test(key)) return err('the Key header must be 1-120 letters, digits, ".", "_", ":" or "-"');
  const format = headers.get('format') ?? 'plain';
  if (format !== 'plain' && format !== 'markdown') return err('the Format header must be plain or markdown');
  return ok({ subject, format, body: lines.slice(i + 1).join('\n'), ...(key === undefined ? {} : { key }) });
}

export interface SpoolPass {
  readonly alias: string;
  readonly directory: string;
  /** Messages handed to the outbox, with what became of each. */
  readonly sent: readonly (NotificationRecord & { readonly file: string })[];
  /** Messages renamed `.rejected-…`, with why. */
  readonly rejected: readonly { readonly file: string; readonly why: string }[];
  /** Messages left for the next pass (the hour's limit). */
  readonly waiting: number;
  /** Why the directory itself could not be read, if it could not. */
  readonly error?: string;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** How many notifications a spool may send in an hour: half the installation's, at least one. */
export function spoolAllowance(perHour: number): number {
  return Math.max(1, Math.floor(perHour / 2));
}

/**
 * Reads every message in the spool, oldest first, and hands each to the outbox for `alias` —
 * at most `allowance` of them that the outbox would send (duplicates do not count).
 */
export async function drainSpool(deps: NotifyDeps, alias: string, directory: string, newTrace: () => string, allowance: number): Promise<SpoolPass> {
  const pass = { alias, directory, sent: [] as (NotificationRecord & { file: string })[], rejected: [] as { file: string; why: string }[], waiting: 0 };
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => !name.startsWith('.'));
  } catch (e) {
    return { ...pass, error: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
  const entries: { name: string; mtime: number; regular: boolean; size: number }[] = [];
  for (const name of names) {
    try {
      const s = await lstat(join(directory, name));
      entries.push({ name, mtime: s.mtimeMs, regular: s.isFile(), size: s.size });
    } catch {
      // Gone since it was listed: nothing to do.
    }
  }
  entries.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

  const reject = async (file: string, why: string): Promise<void> => {
    try {
      await rename(join(directory, file), join(directory, `${REJECTED_PREFIX}${file}`));
    } catch {
      // Left in place, it is rejected again on the next pass.
    }
    pass.rejected.push({ file, why });
  };

  for (const entry of entries) {
    if (!entry.regular) {
      await reject(entry.name, 'not a regular file');
      continue;
    }
    // Headers and the body: generously more than the body limit, never unbounded.
    if (entry.size > deps.config.limits.maxBytes + 4096) {
      await reject(entry.name, `larger than the body limit (${deps.config.limits.maxBytes} bytes)`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(join(directory, entry.name));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      await reject(entry.name, code === 'EACCES' ? 'not readable by the daemon (it must be group-readable)' : code ?? String(e));
      continue;
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      await reject(entry.name, 'not UTF-8 text');
      continue;
    }
    const message = parseSpoolMessage(text);
    if (!message.ok) {
      await reject(entry.name, message.error);
      continue;
    }
    const { subject, key, format, body } = message.value;
    if (pass.sent.filter((s) => s.outcome !== 'duplicate').length >= allowance) {
      pass.waiting++;
      continue;
    }
    const rendered = format === 'markdown' ? markdownEmail(body) : undefined;
    const sent = await sendNotification(deps, {
      to: alias, subject, body: rendered?.text ?? body, trace: newTrace(),
      ...(rendered === undefined ? {} : { html: rendered.html }),
      ...(key === undefined ? {} : { key }),
    });
    if (!sent.ok) {
      if (sent.error.reason === 'rate-limited') {
        pass.waiting++;
        continue;
      }
      if (sent.error.reason === 'unknown-recipient') return { ...pass, error: `"${alias}" is no longer a recipient` };
      await reject(entry.name, sent.error.reason === 'too-large' ? `larger than the body limit (${sent.error.maxBytes} bytes)` : sent.error.reason);
      continue;
    }
    try {
      await unlink(join(directory, entry.name));
    } catch {
      // Already gone; the outbox has it either way.
    }
    pass.sent.push({ ...sent.value, file: entry.name });
  }
  return pass;
}
