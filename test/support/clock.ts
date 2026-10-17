// Deterministic time and IDs for tests. Core functions take a clock and an ID
// source (AGENTS.md §4); these fakes implement the core's types so tests can
// control both without sleeping.

import type { Clock } from '../../src/core/clock/index.ts';
import type { IdSource } from '../../src/core/ids/index.ts';

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function fakeClock(start: Date | string = '2026-01-01T00:00:00.000Z'): FakeClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Sequential, zero-padded IDs ("id-0001"): sortable and reproducible. */
export function fakeIds(prefix = 'id'): IdSource {
  let counter = 0;
  return { next: () => `${prefix}-${String(++counter).padStart(4, '0')}` };
}
