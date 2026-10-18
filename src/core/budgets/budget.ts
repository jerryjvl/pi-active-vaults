// A document's `budget` (concepts.md "Document", "Session tree"): the tokens
// and run time any work it spawns may use, and how work is counted.
//
// Parsing is strict: a budget is the bound on work, so a value that cannot be
// read exactly is an error, never a default.

import { parseDuration } from '../clock/index.ts';
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
  const ttlMs = parseDuration(b['ttl']);
  if (ttlMs === undefined) r.add(issuePath(where, 'ttl'), 'must be a duration such as 90s, 30m or 2h');
  return r.result({ tokens: tokens ?? 0, ttlMs: ttlMs ?? 0 });
}

/** Tokens counted as work: prompt and generated tokens, excluding cached-prefix reads. */
export function workTokens(usage: RequestUsage): number {
  return Math.max(0, usage.prompt - usage.cachedPrefix) + usage.generated;
}

/**
 * A request's usage from a model API's counts: fresh input, output, prefix
 * read from a cache, and input written to one. Every prompt token is one of
 * input, cache read or cache write; only cache reads are not work.
 */
export function usageOf(counts: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }): RequestUsage {
  return { prompt: counts.input + counts.cacheRead + counts.cacheWrite, cachedPrefix: counts.cacheRead, generated: counts.output };
}
