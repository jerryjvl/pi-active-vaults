// Documented behaviour: concepts.md "Actor" — at most one session writes as an
// actor at once. A session holds its actor through a record of its process
// (ID and start time), so a session that has ended, however it ended, holds
// nothing and there is nothing to unlock. Taking a busy actor never waits: it
// says which session holds it. When a holder's state cannot be told, the hold
// stands (one writer is the guarantee).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorHold, actorsSchema, listActorHolds, releaseActorHold, takeActorHold, type Holder } from '../../../src/core/actors/index.ts';
import type { ProcessLiveness } from '../../../src/core/process/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { withStore } from '../../support/store.ts';

/** Processes that are running, by ID, with their start times. */
function processes(running: Record<number, string>, unknown: readonly number[] = []): ProcessLiveness {
  return async (pid) => (unknown.includes(pid) ? { ok: false, error: { reason: 'cannot-tell', pid } } : { ok: true, value: running[pid] });
}

const alice: Holder = { process: { pid: 100, started: 'boot-1:500' }, session: 'session-a' };
const bob: Holder = { process: { pid: 200, started: 'boot-1:900' }, session: 'session-b' };
const where = { vault: 'home', actor: 'gardener' };

test('a free actor is taken; a busy one is refused at once, naming the session that holds it', withStore([actorsSchema], async (store) => {
  const clock = fakeClock();
  const live = processes({ 100: 'boot-1:500', 200: 'boot-1:900' });
  const taken = await takeActorHold(store, live, clock, { ...where, holder: alice });
  assert.deepEqual(taken, { ok: true, value: { ...where, holder: alice, since: '2026-01-01T00:00:00.000Z' } });
  const refused = await takeActorHold(store, live, clock, { ...where, holder: bob });
  assert.deepEqual(refused, { ok: false, error: { reason: 'actor-busy', hold: { ...where, holder: alice, since: '2026-01-01T00:00:00.000Z' } } });
  assert.deepEqual((await actorHold(store, live, 'home', 'gardener'))?.holder, alice);
  assert.ok((await takeActorHold(store, live, clock, { vault: 'home', actor: 'librarian', holder: bob })).ok, 'another actor is free');
  assert.ok((await takeActorHold(store, live, clock, { ...where, holder: alice })).ok, 'the holder taking it again is fine');
}));

test('a hold whose process has ended, or whose ID now belongs to another process, holds nothing', withStore([actorsSchema], async (store) => {
  const clock = fakeClock();
  assert.ok((await takeActorHold(store, processes({}), clock, { ...where, holder: alice })).ok);
  const ended = processes({ 200: 'boot-1:900' });
  assert.equal(await actorHold(store, ended, 'home', 'gardener'), undefined);
  assert.ok((await takeActorHold(store, ended, clock, { ...where, holder: bob })).ok, 'nothing to unlock');

  const reused = processes({ 200: 'boot-2:77', 100: 'boot-1:500' });
  assert.equal(await actorHold(store, reused, 'home', 'gardener'), undefined, 'same process ID, another start time');
  assert.ok((await takeActorHold(store, reused, clock, { ...where, holder: alice })).ok);
}));

test('when the holder\'s state cannot be told, the hold stands', withStore([actorsSchema], async (store) => {
  const clock = fakeClock();
  assert.ok((await takeActorHold(store, processes({ 100: 'boot-1:500' }), clock, { ...where, holder: alice })).ok);
  const unsure = processes({ 200: 'boot-1:900' }, [100]);
  assert.deepEqual((await actorHold(store, unsure, 'home', 'gardener'))?.holder, alice);
  const refused = await takeActorHold(store, unsure, clock, { ...where, holder: bob });
  assert.equal(!refused.ok && refused.error.reason, 'actor-busy');
}));

test('a holder releases only its own hold; listing shows the holds that stand', withStore([actorsSchema], async (store) => {
  const clock = fakeClock();
  const live = processes({ 100: 'boot-1:500', 200: 'boot-1:900' });
  assert.ok((await takeActorHold(store, live, clock, { ...where, holder: alice })).ok);
  assert.ok((await takeActorHold(store, live, clock, { vault: 'home', actor: 'librarian', holder: bob })).ok);
  assert.equal(releaseActorHold(store, { ...where, holder: bob }), false);
  assert.deepEqual((await listActorHolds(store, live)).map((h) => [h.actor, h.holder.session]), [['gardener', 'session-a'], ['librarian', 'session-b']]);
  assert.deepEqual((await listActorHolds(store, processes({ 200: 'boot-1:900' }))).map((h) => h.actor), ['librarian'], 'an ended holder is not listed');
  assert.equal(releaseActorHold(store, { ...where, holder: alice }), true);
  assert.equal(await actorHold(store, live, 'home', 'gardener'), undefined);
}));
