// Documented behaviour: time is injected (core.md "Deterministic"), so the real
// clock is only the default and the fake from test support is interchangeable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock, type Clock } from '../../../src/core/clock/index.ts';
import { fakeClock } from '../../support/clock.ts';

test('the system clock reports the current time', () => {
  const before = Date.now();
  const reading = systemClock.now().getTime();
  const after = Date.now();
  assert.ok(reading >= before && reading <= after);
});

test('the fake clock can stand in for any Clock', () => {
  const clock: Clock = fakeClock('2026-03-01T12:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-03-01T12:00:00.000Z');
});
