// Parsing `applies-when`: a list of conditions, each naming an event, filtering
// on it and having an effect (concepts.md "applies-when").
//
// Parsing is strict. Each event takes only its own filters, and a misspelt or
// misplaced field is an issue rather than ignored, because an ignored filter
// would make a condition fire more widely than its author meant. Only session
// events can inject (there is no session to inject into otherwise), and only
// spawns take a context or a script. A condition's script must be one of the
// vault's own: built-ins act (`builtin:notify` sends mail), and a filter only
// decides.

import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';
import { globIssue } from './globs.ts';

export const EVENT_KINDS = ['timer', 'committed', 'merged', 'session.start', 'session.tool', 'session.path', 'external'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const CHANGE_KINDS = ['created', 'modified', 'deleted', 'renamed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

const EFFECTS = ['inject', 'spawn'] as const;
const MISSED = ['run-once', 'skip'] as const;
const SPAWN_CONTEXTS = ['session-preferred', 'bare', 'session-required'] as const;

export interface Condition {
  readonly on: EventKind;
  readonly effect: (typeof EFFECTS)[number];
  /** Timer: a cron expression. */
  readonly schedule?: string;
  /** Timer: what to do about runs missed while nothing was running (default `run-once`). */
  readonly missed?: (typeof MISSED)[number];
  readonly paths?: readonly string[];
  readonly change?: readonly ChangeKind[];
  readonly labels?: readonly string[];
  /** Git events: the actors whose changes match (their `Vault-Actor`). */
  readonly actor?: readonly string[];
  readonly tools?: readonly string[];
  readonly model?: string;
  /** External: the event name given to `vault trigger`. */
  readonly name?: string;
  /** Spawn only: a vault script that must exit 0, given the event, for the spawn to happen. */
  readonly script?: string;
  /** Spawn only (default `session-preferred`). */
  readonly context?: (typeof SPAWN_CONTEXTS)[number];
}

type Filter = 'schedule' | 'missed' | 'paths' | 'change' | 'labels' | 'actor' | 'tools' | 'model' | 'name';

/** Read in this order, so issues come in a stable order. */
const FILTER_ORDER: readonly Filter[] = ['schedule', 'missed', 'paths', 'change', 'labels', 'actor', 'tools', 'model', 'name'];

const FILTERS: Readonly<Record<EventKind, readonly Filter[]>> = {
  timer: ['schedule', 'missed'],
  committed: ['paths', 'change', 'labels', 'actor'],
  merged: ['paths', 'change', 'labels', 'actor'],
  'session.start': ['model'],
  'session.tool': ['tools', 'model'],
  'session.path': ['paths', 'model'],
  external: ['name'],
};

const REQUIRED: Readonly<Partial<Record<EventKind, Filter>>> = { timer: 'schedule', external: 'name' };

// Five whitespace-separated fields; the schedule's meaning is checked where
// timers are evaluated.
const CRON_SHAPE = /^\S+(?:\s+\S+){4}$/;

// A script in `.vault/scripts/` by name: no directory, not hidden, not a built-in.
const VAULT_SCRIPT_NAME = /^[A-Za-z0-9_-][^/\\:\s]*$/;

function nonEmptyList(r: DataReader, value: unknown, path: string): unknown[] {
  const items = r.list(value, path);
  if (Array.isArray(value) && items.length === 0) r.add(path, 'must not be empty');
  return items;
}

function readFilter(r: DataReader, field: Filter, value: unknown, path: string): Partial<Condition> {
  switch (field) {
    case 'schedule': {
      const schedule = r.string(value, path);
      if (schedule !== '' && !CRON_SHAPE.test(schedule.trim())) r.add(path, 'must be a cron expression of five fields');
      return { schedule };
    }
    case 'missed': {
      const missed = r.oneOf(value, path, MISSED);
      return missed === undefined ? {} : { missed };
    }
    case 'paths':
      return {
        paths: nonEmptyList(r, value, path).map((item, i) => {
          const glob = r.string(item, `${path}[${i}]`);
          const issue = glob === '' ? undefined : globIssue(glob);
          if (issue !== undefined) r.add(`${path}[${i}]`, issue);
          return glob;
        }),
      };
    case 'change':
      return { change: nonEmptyList(r, value, path).flatMap((item, i) => r.oneOf(item, `${path}[${i}]`, CHANGE_KINDS) ?? []) };
    case 'labels':
    case 'actor':
    case 'tools':
      return { [field]: nonEmptyList(r, value, path).map((item, i) => r.string(item, `${path}[${i}]`)) };
    case 'model':
    case 'name':
      return { [field]: r.string(value, path) };
  }
}

/** Reads one condition into `r`; undefined when its event is unknown (nothing else can be checked). */
export function readCondition(r: DataReader, value: unknown, path: string): Condition | undefined {
  const c = r.record(value, path, ['on', 'effect', ...FILTER_ORDER, 'script', 'context']);
  const on = r.oneOf(c['on'], issuePath(path, 'on'), EVENT_KINDS);
  const effect = r.oneOf(c['effect'], issuePath(path, 'effect'), EFFECTS);
  if (on === undefined) return undefined;

  let condition: Condition = { on, effect: effect ?? 'spawn' };
  for (const field of FILTER_ORDER) {
    const where = issuePath(path, field);
    if (c[field] === undefined) {
      if (REQUIRED[on] === field) r.add(where, `is required for ${on} events`);
    } else if (!FILTERS[on].includes(field)) {
      r.add(where, `does not apply to ${on} events`);
    } else {
      condition = { ...condition, ...readFilter(r, field, c[field], where) };
    }
  }
  if (on === 'timer' && condition.missed === undefined) condition = { ...condition, missed: 'run-once' };

  if (effect === 'inject' && !on.startsWith('session.')) r.add(issuePath(path, 'effect'), 'inject needs a session event');
  if (c['script'] !== undefined && effect !== 'spawn') {
    r.add(issuePath(path, 'script'), 'applies only to spawn');
  } else if (c['script'] !== undefined) {
    const script = r.string(c['script'], issuePath(path, 'script'));
    if (script !== '' && !VAULT_SCRIPT_NAME.test(script)) r.add(issuePath(path, 'script'), 'must name one of the vault\'s scripts');
    condition = { ...condition, script };
  }
  if (c['context'] !== undefined && effect !== 'spawn') {
    r.add(issuePath(path, 'context'), 'applies only to spawn');
  } else if (effect === 'spawn') {
    const context = c['context'] === undefined ? 'session-preferred' : r.oneOf(c['context'], issuePath(path, 'context'), SPAWN_CONTEXTS);
    if (context !== undefined) condition = { ...condition, context };
  }
  return condition;
}

/** Parses an `applies-when` value; every problem is reported, by location. */
export function parseConditions(value: unknown, path = 'applies-when'): Result<Condition[], Issue[]> {
  const r = new DataReader();
  const conditions = r.list(value, path).flatMap((item, i) => readCondition(r, item, `${path}[${i}]`) ?? []);
  return r.result(conditions);
}
