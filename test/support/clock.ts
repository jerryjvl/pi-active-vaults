// Deterministic time and IDs for tests. Core functions take a clock and an ID
// source (AGENTS.md §4); these fakes let tests control both without sleeping.
// Stage 1 defines the core's Clock and IdSource types; these must implement them.

export interface FakeClock {
  now(): Date;
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

export interface FakeIds {
  next(prefix?: string): string;
}

/** Sequential, zero-padded IDs ("id-0001"): sortable and reproducible. */
export function fakeIds(): FakeIds {
  let counter = 0;
  return {
    next: (prefix = 'id') => `${prefix}-${String(++counter).padStart(4, '0')}`,
  };
}
