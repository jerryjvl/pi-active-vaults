// Time is injected, never read ambiently, so behaviour is deterministic under
// test. Core functions take a `Clock`; only adapters construct `systemClock`.
// Durations are read here too, in the one form documents and config use.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** The UTC date of `date`, `yyyy-mm-dd`: days that do not depend on the machine's time zone. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DURATION = /^([1-9]\d*)(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** A duration written as whole seconds, minutes or hours (`90s`, `30m`, `2h`), in milliseconds; undefined otherwise. */
export function parseDuration(value: unknown): number | undefined {
  const found = typeof value === 'string' ? DURATION.exec(value) : null;
  return found === null ? undefined : Number(found[1]) * UNIT_MS[found[2] as keyof typeof UNIT_MS];
}
