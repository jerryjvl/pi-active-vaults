// Trace IDs and compact trace records (concepts.md "Trace").
//
// The compact record is the part of a trace kept in the vault: it is committed
// with the run's other changes on its actor branch, so it travels with the
// work it explains. It holds only what explains a run — its trigger, sessions,
// judgements, scripts and the documents it produced — and is written as
// deterministic JSON so the same run always yields the same bytes.
//
// Invariants: a record is checked in full before it is written and when it is
// read, and a malformed one is refused with every problem, never read in part;
// a run's part in another vault appears only as an opaque reference, which
// names neither that vault nor anything in it (principle 12) and differs from
// run to run, so references cannot be used to link runs.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENT_KINDS, type EventKind } from '../conditions/index.ts';
import { PACKAGE_DIRECTORY } from '../documents/index.ts';
import { isTraceId, traceIdTime, type IdSource } from '../ids/index.ts';
import { DataReader, err, issuePath, ok, type Issue, type Result } from '../result/index.ts';

/** Where the compact records live in a vault. */
const TRACES_DIRECTORY = `${PACKAGE_DIRECTORY}/traces`;

export interface TraceTrigger {
  /** The event that started the run, or `manual` for `vault run`. */
  readonly event: EventKind | 'manual';
  /** The job document that ran. */
  readonly document?: string;
  readonly commit?: string;
  /** External events: the event name. */
  readonly name?: string;
  /** Timers: the scheduled time (ISO 8601). */
  readonly at?: string;
}

export interface TraceSession {
  readonly actor: string;
  readonly session?: string;
  readonly started: string;
  readonly ended?: string;
  /** Work tokens counted against the session's budget. */
  readonly tokens: number;
  readonly outcome: 'committed' | 'stopped';
  /** Why a stopped session stopped. */
  readonly reason?: string;
}

export interface CompactTrace {
  readonly trace: string;
  readonly vault: string;
  /** The causal path: the trace IDs of the runs that led to this one, root first. */
  readonly path: readonly string[];
  readonly trigger: TraceTrigger;
  readonly sessions: readonly TraceSession[];
  readonly judgements: readonly { readonly name: string; readonly subject: string; readonly result: string }[];
  readonly scripts: readonly { readonly name: string; readonly exitCode: number | null }[];
  /** Vault paths of the documents the run produced. */
  readonly documents: readonly string[];
  /** Opaque references to the run's parts in other vaults. */
  readonly elsewhere: readonly string[];
}

const KEYS = ['trace', 'vault', 'path', 'trigger', 'sessions', 'judgements', 'scripts', 'documents', 'elsewhere'] as const;
const OPAQUE_REFERENCE = /^ref:[0-9a-f]{16}$/;
const TRIGGER_EVENTS = [...EVENT_KINDS, 'manual'] as const;
const OUTCOMES = ['committed', 'stopped'] as const;

/** A new trace ID: the one place runs get their identity. */
export function newTraceId(ids: IdSource): string {
  return ids.next();
}

function assertTraceId(id: string): void {
  if (!isTraceId(id)) throw new Error('not a trace ID');
}

/** `.vault/traces/<yyyy>/<mm>/<trace-id>.json`, by the trace's issue time in UTC. */
export function compactTracePath(trace: string): string {
  assertTraceId(trace);
  const issued = traceIdTime(trace);
  if (issued === undefined) throw new Error('not a trace ID');
  const month = String(issued.getUTCMonth() + 1).padStart(2, '0');
  return `${TRACES_DIRECTORY}/${issued.getUTCFullYear()}/${month}/${trace}.json`;
}

/** The reference a run's record in one vault makes to its part in `vault`. */
export function opaqueReference(trace: string, vault: string): string {
  return `ref:${createHash('sha256').update(`${trace}\0${vault}`).digest('hex').slice(0, 16)}`;
}

function traceIdIn(r: DataReader, value: unknown, path: string): string {
  const text = r.string(value, path);
  if (text !== '' && !isTraceId(text)) r.add(path, 'must be a trace ID');
  return text;
}

function count(r: DataReader, value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) r.add(path, 'must be a whole number, 0 or more');
  return typeof value === 'number' ? value : 0;
}

function optional<T>(record: Record<string, unknown>, key: string, read: (value: unknown) => T): { [k: string]: T } {
  return record[key] === undefined ? {} : { [key]: read(record[key]) };
}

function readTrigger(r: DataReader, value: unknown): TraceTrigger {
  const t = r.record(value, 'trigger', ['event', 'document', 'commit', 'name', 'at']);
  return {
    event: r.oneOf(t['event'], 'trigger.event', TRIGGER_EVENTS) ?? 'manual',
    ...optional(t, 'document', (v) => r.string(v, 'trigger.document')),
    ...optional(t, 'commit', (v) => r.string(v, 'trigger.commit')),
    ...optional(t, 'name', (v) => r.string(v, 'trigger.name')),
    ...optional(t, 'at', (v) => r.string(v, 'trigger.at')),
  };
}

function readSession(r: DataReader, value: unknown, path: string): TraceSession {
  const s = r.record(value, path, ['actor', 'session', 'started', 'ended', 'tokens', 'outcome', 'reason']);
  return {
    actor: r.string(s['actor'], issuePath(path, 'actor')),
    ...optional(s, 'session', (v) => r.string(v, issuePath(path, 'session'))),
    started: r.string(s['started'], issuePath(path, 'started')),
    ...optional(s, 'ended', (v) => r.string(v, issuePath(path, 'ended'))),
    tokens: count(r, s['tokens'], issuePath(path, 'tokens')),
    outcome: r.oneOf(s['outcome'], issuePath(path, 'outcome'), OUTCOMES) ?? 'stopped',
    ...optional(s, 'reason', (v) => r.string(v, issuePath(path, 'reason'))),
  };
}

function readCompactTrace(value: unknown): Result<CompactTrace, Issue[]> {
  const r = new DataReader();
  const t = r.record(value, '', KEYS);
  const trace: CompactTrace = {
    trace: traceIdIn(r, t['trace'], 'trace'),
    vault: r.string(t['vault'], 'vault'),
    path: r.list(t['path'], 'path').map((item, i) => traceIdIn(r, item, `path[${i}]`)),
    trigger: readTrigger(r, t['trigger']),
    sessions: r.list(t['sessions'], 'sessions').map((item, i) => readSession(r, item, `sessions[${i}]`)),
    judgements: r.list(t['judgements'], 'judgements').map((item, i) => {
      const path = `judgements[${i}]`;
      const j = r.record(item, path, ['name', 'subject', 'result']);
      return { name: r.string(j['name'], issuePath(path, 'name')), subject: r.string(j['subject'], issuePath(path, 'subject')), result: r.string(j['result'], issuePath(path, 'result')) };
    }),
    scripts: r.list(t['scripts'], 'scripts').map((item, i) => {
      const path = `scripts[${i}]`;
      const s = r.record(item, path, ['name', 'exitCode']);
      const exitCode = s['exitCode'] === null ? null : count(r, s['exitCode'], issuePath(path, 'exitCode'));
      return { name: r.string(s['name'], issuePath(path, 'name')), exitCode };
    }),
    documents: r.stringList(t['documents'], 'documents'),
    elsewhere: r.stringList(t['elsewhere'], 'elsewhere').map((ref, i) => {
      if (ref !== '' && !OPAQUE_REFERENCE.test(ref)) r.add(`elsewhere[${i}]`, 'must be an opaque reference');
      return ref;
    }),
  };
  return r.result(trace);
}

/** Reads a compact record; anything but a complete, well-formed record is refused with every problem. */
export function parseCompactTrace(text: string): Result<CompactTrace, Issue[]> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err([{ path: '', message: 'is not valid JSON' }]);
  }
  return readCompactTrace(value);
}

/** The record as written: keys in a fixed order, two-space indentation, a final newline. */
export function renderCompactTrace(trace: CompactTrace): string {
  // Re-reading the record puts its keys in the fixed order and drops nothing it should keep.
  const checked = readCompactTrace(trace);
  if (!checked.ok) throw new Error(`invalid compact trace: ${checked.error.map((i) => i.path).join(', ')}`);
  return `${JSON.stringify(checked.value, null, 2)}\n`;
}

/** Writes the record into a worktree at its path; returns that vault path, for the run's commit. */
export function writeCompactTrace(worktree: string, trace: CompactTrace): Result<string, Issue[]> {
  const checked = readCompactTrace(trace);
  if (!checked.ok) return checked;
  const path = compactTracePath(trace.trace);
  const file = join(worktree, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderCompactTrace(checked.value));
  return ok(path);
}
