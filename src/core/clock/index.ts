// Time is injected, never read ambiently, so behaviour is deterministic under
// test. Core functions take a `Clock`; only adapters construct `systemClock`.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
