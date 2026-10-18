// Timer conditions (concepts.md "applies-when", daemon.md "Timers"): a cron
// schedule, evaluated in local time, and which runs it asks for as time
// passes.
//
// A run is identified by its slot: the local date and scheduled minute,
// `YYYY-MM-DDTHH:MM`. Slots are compared as local wall-clock times, never as
// instants, so a change of the clocks neither repeats a run nor skips one:
// when they go back, the repeated hour's slots are the ones already passed;
// when they go forward, the skipped hour's slots are due at the first minute
// after the gap. The schedule is matched against wall-clock time itself
// (evaluated as if in UTC, which has no clock changes), through `croner`.
//
// Invariants: a timer seen for the first time fires nothing for the past; a
// cursor never moves back; runs missed while nothing was running collapse to
// one run (`run-once`) or none (`skip`), whatever their number.

import { Cron } from 'croner';
import { err, ok, type Issue, type Result } from '../result/index.ts';

/** `YYYY-MM-DDTHH:MM`, local time: the identity of a timer run. */
export type Slot = string;

export interface Schedule {
  readonly expression: string;
  /** The first slot after `slot`, if the schedule has one. */
  after(slot: Slot): Slot | undefined;
  /** The last slot before `slot`, if the schedule has one. */
  before(slot: Slot): Slot | undefined;
}

const SLOT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A slot as the instant it would be in UTC: wall-clock time without clock changes. */
function wallClock(slot: Slot): Date {
  const m = SLOT.exec(slot);
  if (m === null) throw new Error('not a timer slot');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
}

function slotOf(wall: Date): Slot {
  return wall.toISOString().slice(0, 16);
}

/** A five-field cron expression, checked; never echoed in the issue. */
export function parseSchedule(expression: string, path = 'schedule'): Result<Schedule, Issue[]> {
  let cron: Cron;
  try {
    // No callback: the expression is only evaluated, never scheduled.
    cron = new Cron(expression.trim(), { timezone: 'Etc/UTC', mode: '5-part' });
  } catch {
    return err([{ path, message: 'must be a cron expression of five fields' }]);
  }
  return ok({
    expression,
    after: (slot) => {
      const next = cron.nextRun(wallClock(slot));
      return next === null ? undefined : slotOf(next);
    },
    before: (slot) => {
      const [previous] = cron.previousRuns(1, wallClock(slot));
      return previous === undefined ? undefined : slotOf(previous);
    },
  });
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The slot `instant` falls in, in `timeZone` (an IANA name). */
export function localSlot(instant: Date, timeZone: string): Slot {
  let format = FORMATS.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    FORMATS.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`;
}

export interface TimerTick {
  /** The last slot this timer was handled up to; absent the first time it is seen. */
  readonly cursor?: Slot;
  /** The slot of this tick. */
  readonly now: Slot;
  /**
   * The slot of the previous tick while running; absent at start (or after
   * the process was suspended), when the slots before this one were missed.
   */
  readonly previous?: Slot;
}

/** The most slots one tick enumerates while running; ticks are a minute apart, so this is never reached. */
const MAX_ON_TIME = 1440;

function minuteBefore(slot: Slot): Slot {
  return slotOf(new Date(wallClock(slot).getTime() - 60_000));
}

/**
 * The runs a tick asks for, oldest first, and where the timer's cursor moves
 * to. While running, every slot since the cursor came due on time; at start,
 * only the slot of this minute did, and those before it were missed: the
 * latest of them runs once (`run-once`), or none does (`skip`).
 */
export function timerFirings(schedule: Schedule, missed: 'run-once' | 'skip', tick: TimerTick): { fire: Slot[]; advanceTo: Slot } {
  const { cursor, now, previous } = tick;
  if (cursor === undefined) return { fire: [], advanceTo: now };
  if (now <= cursor) return { fire: [], advanceTo: cursor };
  const fire: Slot[] = [];
  if (previous === undefined) {
    const latestMissed = schedule.before(now);
    if (missed === 'run-once' && latestMissed !== undefined && latestMissed > cursor) fire.push(latestMissed);
    if (schedule.after(minuteBefore(now)) === now) fire.push(now);
  } else {
    for (let slot = schedule.after(cursor); slot !== undefined && slot <= now && fire.length < MAX_ON_TIME; slot = schedule.after(slot)) fire.push(slot);
  }
  return { fire, advanceTo: now };
}
