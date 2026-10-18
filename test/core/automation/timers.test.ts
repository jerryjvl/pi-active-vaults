// Documented behaviour: daemon.md "Timers" — the daemon evaluates timer
// conditions each minute and applies `missed` on start; a timer run is
// identified by its local date and scheduled time. concepts.md "applies-when"
// — `missed: run-once` (default) or `skip` for runs missed while nothing was
// running. security.md — a vault with an unaccepted change runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSpawns } from '../../../src/core/queue/index.ts';
import { automationFor, fakePi, jobDocument } from '../../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';

const MINUTE = 60_000;
const timers = (t: TestInstallation) => listSpawns(t.context.state).map((s) => [s.document, s.event.kind === 'timer' ? s.event.at : '']);

function daily(t: TestInstallation, missed = 'run-once'): void {
  t.repo.write('jobs/daily.md', jobDocument(`[{ on: timer, schedule: "30 6 * * *", missed: ${missed}, effect: spawn }]`));
  t.accept(t.repo.commit('daily job'));
}

test('a timer fires once when its slot comes due, and is identified by its local date and time', withInstallation(async (t) => {
  daily(t);
  t.clock.advance((6 * 60 + 28) * MINUTE);
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  for (let i = 0; i < 3; i++) {
    t.clock.advance(MINUTE);
    await automation.tick();
  }
  assert.deepEqual(timers(t), [['jobs/daily.md', '2026-01-01T06:30']]);
}, { host: true }));

test('in the installation\'s time zone: 06:30 in Amsterdam is 05:30 UTC in winter', withInstallation(async (t) => {
  daily(t);
  t.clock.advance((5 * 60 + 28) * MINUTE);
  const automation = automationFor(t, fakePi(t), { timeZone: 'Europe/Amsterdam' });
  await automation.start();
  for (let i = 0; i < 3; i++) {
    t.clock.advance(MINUTE);
    await automation.tick();
  }
  assert.deepEqual(timers(t), [['jobs/daily.md', '2026-01-01T06:30']]);
}, { host: true }));

test('runs missed while the daemon was down: run-once runs the latest once on start', withInstallation(async (t) => {
  daily(t);
  const before = automationFor(t, fakePi(t));
  await before.start();
  await before.stop();
  t.clock.advance(3 * 24 * 60 * MINUTE + 8 * 60 * MINUTE);
  await automationFor(t, fakePi(t)).start();
  assert.deepEqual(timers(t), [['jobs/daily.md', '2026-01-04T06:30']]);
}, { host: true }));

test('runs missed while the daemon was down: skip runs none of them', withInstallation(async (t) => {
  daily(t, 'skip');
  const before = automationFor(t, fakePi(t));
  await before.start();
  await before.stop();
  t.clock.advance(3 * 24 * 60 * MINUTE);
  await automationFor(t, fakePi(t)).start();
  assert.deepEqual(timers(t), []);
}, { host: true }));

test('a timer seen for the first time fires nothing for the past', withInstallation(async (t) => {
  t.clock.advance(10 * 60 * MINUTE);
  daily(t);
  await automationFor(t, fakePi(t)).start();
  assert.deepEqual(timers(t), []);
}, { host: true }));

test('while a vault has an unaccepted change its timers do not fire; what it missed then counts as missed', withInstallation(async (t) => {
  daily(t);
  t.clock.advance(6 * 60 * MINUTE);
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  t.repo.write('stray.md', 'x');
  const stray = t.repo.commit('stray');
  for (const step of [29, 1, 1]) {
    t.clock.advance(step * MINUTE);
    await automation.tick();
  }
  assert.deepEqual(timers(t), [], 'paused');
  t.accept(stray);
  t.clock.advance(MINUTE);
  await automation.tick();
  assert.deepEqual(timers(t), [['jobs/daily.md', '2026-01-01T06:30']], 'run once for what it missed while paused');
}, { host: true }));

test('a vault this installation does not host fires no timers', withInstallation(async (t) => {
  daily(t);
  t.clock.advance((6 * 60 + 29) * MINUTE);
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  t.clock.advance(MINUTE);
  await automation.tick();
  assert.deepEqual(timers(t), []);
}));
