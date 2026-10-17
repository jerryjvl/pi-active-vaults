// Time is injected, never read ambiently, so behaviour is deterministic under
// test. Core functions take a `Clock`; only adapters construct `systemClock`.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** The UTC date of `date`, `yyyy-mm-dd`: days that do not depend on the machine's time zone. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
