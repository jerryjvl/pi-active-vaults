// A document's `budget` (concepts.md "Document", "Session tree"): the tokens
// and run time any work it spawns may use, and how work is counted.
//
// Parsing is strict: a budget is the bound on work, so a value that cannot be
// read exactly is an error, never a default.

import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

export interface Budget {
  readonly tokens: number;
  /** Run time; queue time is limited separately. */
  readonly ttlMs: number;
}

/** What one model request used, as the session reports it. */
export interface RequestUsage {
  /** Every prompt token, the cached prefix included. */
  readonly prompt: number;
  /** Prompt tokens read from a cached prefix. */
  readonly cachedPrefix: number;
  readonly generated: number;
}

const DURATION = /^([1-9]\d*)(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `budget: { tokens, ttl }`, with `ttl` written as whole seconds, minutes or hours: `90s`, `30m`, `2h`. */
export function parseBudget(value: unknown, where = 'budget'): Result<Budget, Issue[]> {
  const r = new DataReader();
  if (value === undefined) {
    r.add(where, 'is required on a document that can spawn work');
    return r.result({ tokens: 0, ttlMs: 0 });
  }
  const b = r.record(value, where, ['tokens', 'ttl']);
  const tokens = r.integer(b, 'tokens', where);
  if (tokens === undefined && b['tokens'] === undefined) r.add(issuePath(where, 'tokens'), 'is required');
  const ttl = typeof b['ttl'] === 'string' ? DURATION.exec(b['ttl']) : null;
  if (ttl === null) r.add(issuePath(where, 'ttl'), 'must be a duration such as 90s, 30m or 2h');
  const ttlMs = ttl === null ? 0 : Number(ttl[1]) * UNIT_MS[ttl[2] as keyof typeof UNIT_MS];
  return r.result({ tokens: tokens ?? 0, ttlMs });
}

/** Tokens counted as work: prompt and generated tokens, excluding cached-prefix reads. */
export function workTokens(usage: RequestUsage): number {
  return Math.max(0, usage.prompt - usage.cachedPrefix) + usage.generated;
}
