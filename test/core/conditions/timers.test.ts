// Documented behaviour: daemon.md "Timers" — timer conditions are evaluated
// each minute; a timer run is identified by its local date and scheduled
// time, so a clock change (daylight saving) neither repeats nor skips it;
// `missed` applies on start: `run-once` (default) runs once for everything
// missed while nothing was running, `skip` runs none of it. concepts.md
// "applies-when" — `schedule` is a cron expression (five fields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localSlot, parseConditions, parseSchedule, timerFirings } from '../../../src/core/conditions/index.ts';

const AMSTERDAM = 'Europe/Amsterdam';
const schedule = (expression: string) => {
  const parsed = parseSchedule(expression);
  assert.ok(parsed.ok, expression);
  return parsed.value;
};

test('a slot is the local date and minute of an instant, in the given time zone', () => {
  assert.equal(localSlot(new Date('2026-07-01T04:30:59Z'), AMSTERDAM), '2026-07-01T06:30');
  assert.equal(localSlot(new Date('2026-12-01T05:30:00Z'), AMSTERDAM), '2026-12-01T06:30');
  assert.equal(localSlot(new Date('2026-12-01T05:30:00Z'), 'UTC'), '2026-12-01T05:30');
});

test('while running, each slot that comes due fires once', () => {
  const daily = schedule('30 6 * * *');
  assert.deepEqual(timerFirings(daily, 'run-once', { cursor: '2026-07-01T06:29', now: '2026-07-01T06:30', previous: '2026-07-01T06:29' }), { fire: ['2026-07-01T06:30'], advanceTo: '2026-07-01T06:30' });
  assert.deepEqual(timerFirings(daily, 'run-once', { cursor: '2026-07-01T06:30', now: '2026-07-01T06:31', previous: '2026-07-01T06:30' }), { fire: [], advanceTo: '2026-07-01T06:31' });
  const quarter = schedule('*/15 * * * *');
  assert.deepEqual(timerFirings(quarter, 'skip', { cursor: '2026-07-01T06:29', now: '2026-07-01T06:46', previous: '2026-07-01T06:29' }).fire, ['2026-07-01T06:30', '2026-07-01T06:45'], 'a late tick still fires what came due since the last');
});

test('when the clocks go forward, a run in the skipped hour is not skipped', () => {
  const night = schedule('30 2 * * *');
  // Amsterdam, 29 March 2026: 02:00 becomes 03:00.
  const before = localSlot(new Date('2026-03-29T00:59:00Z'), AMSTERDAM);
  const after = localSlot(new Date('2026-03-29T01:00:00Z'), AMSTERDAM);
  assert.deepEqual([before, after], ['2026-03-29T01:59', '2026-03-29T03:00']);
  assert.deepEqual(timerFirings(night, 'skip', { cursor: before, now: after, previous: before }).fire, ['2026-03-29T02:30']);
});

test('when the clocks go back, a run in the repeated hour is not repeated', () => {
  const night = schedule('30 2 * * *');
  // Amsterdam, 25 October 2026: 03:00 becomes 02:00 again.
  const first = localSlot(new Date('2026-10-25T00:30:00Z'), AMSTERDAM);
  const second = localSlot(new Date('2026-10-25T01:30:00Z'), AMSTERDAM);
  assert.equal(first, second, 'the same local date and time');
  const fired = timerFirings(night, 'run-once', { cursor: '2026-10-25T02:29', now: first, previous: '2026-10-25T02:29' });
  assert.deepEqual(fired.fire, ['2026-10-25T02:30']);
  const later = localSlot(new Date('2026-10-25T01:29:00Z'), AMSTERDAM);
  assert.deepEqual(timerFirings(night, 'run-once', { cursor: fired.advanceTo, now: later, previous: fired.advanceTo }), { fire: [], advanceTo: fired.advanceTo }, 'the cursor never moves back');
  assert.deepEqual(timerFirings(night, 'run-once', { cursor: fired.advanceTo, now: second, previous: later }).fire, []);
});

test('runs missed while nothing was running: run-once runs the latest once, skip runs none', () => {
  const daily = schedule('30 6 * * *');
  const down = { cursor: '2026-07-01T06:30', now: '2026-07-04T08:00' };
  assert.deepEqual(timerFirings(daily, 'run-once', down), { fire: ['2026-07-04T06:30'], advanceTo: '2026-07-04T08:00' });
  assert.deepEqual(timerFirings(daily, 'skip', down), { fire: [], advanceTo: '2026-07-04T08:00' });
  assert.deepEqual(timerFirings(daily, 'skip', { cursor: '2026-07-01T06:30', now: '2026-07-04T06:30' }).fire, ['2026-07-04T06:30'], 'the slot due as it starts is on time');
  const minutely = schedule('* * * * *');
  assert.deepEqual(timerFirings(minutely, 'run-once', { cursor: '2026-01-01T00:00', now: '2026-07-01T00:00' }).fire, ['2026-06-30T23:59', '2026-07-01T00:00'], 'months away: the latest missed, and the one due now');
});

test('a timer seen for the first time fires nothing for the past: it starts now', () => {
  assert.deepEqual(timerFirings(schedule('30 6 * * *'), 'run-once', { now: '2026-07-01T07:00' }), { fire: [], advanceTo: '2026-07-01T07:00' });
});

test('a schedule must be a valid cron expression of five fields', () => {
  for (const bad of ['61 * * * *', '* * * * * *', 'every day', '30 6 * * MOON']) {
    const parsed = parseConditions([{ on: 'timer', schedule: bad, effect: 'spawn' }]);
    assert.ok(!parsed.ok, bad);
    assert.deepEqual(parsed.error.map((i) => i.path), ['applies-when[0].schedule'], bad);
    assert.ok(parsed.error.every((i) => !i.message.includes(bad)), 'never repeats the value');
  }
  assert.ok(parseConditions([{ on: 'timer', schedule: '*/15 9-17 * * MON-FRI', effect: 'spawn' }]).ok);
});
