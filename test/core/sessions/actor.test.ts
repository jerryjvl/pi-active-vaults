// Documented behaviour: extension.md "Actor and budget" and concepts.md
// "Actor" — an interactive session writes as one actor (its worktree's, else
// `--vault-actor`, else the installation's person, even outside every vault)
// in every vault where that actor may write, each time in that actor's
// worktree there, holding the actor in a vault from its first write there.
// Only the person changes the actor (`/vault actor`): holds are released,
// uncommitted work stays where it is and is said, and a name that writes
// nowhere changes nothing. A headless run writes as its job's actor only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actorHold, takeActorHold } from '../../../src/core/actors/index.ts';
import {
  describeWriting, guardToolCall, holdForOperation, switchActor, switchRefusalText, type GuardedCall, type VaultSession,
} from '../../../src/core/sessions/index.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { OTHER_HOLDER, RUNNING, openTestSession, runOf, startedSpawn } from '../../support/session.ts';

// A second vault alice may not write in: owned by bob, with the actor scribe.
const OTHERS = { running: RUNNING, others: [{ id: 'work', contract: { id: 'work', owners: ['bob'], actors: ['scribe'] } }] };

const write = (path: string): GuardedCall => ({ kind: 'write', path });

function work(t: TestInstallation) {
  const other = t.others['work'];
  assert.ok(other !== undefined);
  return other;
}

async function outside(t: TestInstallation): Promise<VaultSession> {
  return openTestSession(t, { cwd: t.dir.path });
}

test('outside every vault, a session writes as the person, in their worktree of each vault they may write in, holding it from the first write', withInstallation(async (t) => {
  const s = await outside(t);
  assert.equal(s.vault, undefined);
  assert.equal(s.actor, 'alice');
  assert.equal(s.holds.size, 0, 'nothing is held before a write');
  assert.deepEqual(await guardToolCall(t.context, s, write(join(t.vault.worktrees, 'alice', 'notes', 'a.md'))), { allowed: true });
  assert.ok(s.holds.has('home'));
  assert.equal((await actorHold(t.context.state, t.context.alive, 'home', 'alice'))?.holder.session, 'pi-session-1');
  assert.equal(await actorHold(t.context.state, t.context.alive, 'work', 'alice'), undefined);
}, OTHERS));

test('in a vault its actor may not write in, the session writes nothing, and is told that only the person can change its actor', withInstallation(async (t) => {
  const s = await outside(t);
  const { vault } = work(t);
  for (const path of [join(vault.worktrees, 'alice', 'a.md'), join(vault.path, 'a.md')]) {
    const blocked = await guardToolCall(t.context, s, write(path));
    assert.ok(!blocked.allowed && /alice is not one of the actors or owners of vault "work"/.test(blocked.reason), JSON.stringify(blocked));
    assert.ok(!blocked.allowed && /only the person can change the session's actor, with \/vault actor <name>/i.test(blocked.reason));
  }
}, OTHERS));

test('an operation on one vault takes the hold there; one over many vaults takes none', withInstallation(async (t) => {
  const s = await outside(t);
  await holdForOperation(t.context, s, 'many', t.context.installation.vaults);
  assert.equal(s.holds.size, 0);
  await holdForOperation(t.context, s, 'one', [t.vault]);
  assert.deepEqual([...s.holds], ['home']);
}, OTHERS));

test('where the session writes is described vault by vault: its worktree, or why not', withInstallation(async (t) => {
  const s = await outside(t);
  const text = await describeWriting(t.context, s);
  assert.match(text, /writes as alice/);
  assert.ok(text.includes(`home: ${join(t.vault.worktrees, 'alice')}`), text);
  assert.match(text, /work: alice is not one of the actors or owners/);
  assert.match(text, /\/vault actor <name>/);
}, OTHERS));

test('switching actor releases the holds, and the session then writes only in the new actor\'s worktrees', withInstallation(async (t) => {
  const s = await outside(t);
  const alice = join(t.vault.worktrees, 'alice', 'a.md');
  assert.deepEqual(await guardToolCall(t.context, s, write(alice)), { allowed: true });
  const switched = await switchActor(t.context, s, 'gardener');
  assert.ok(switched.ok, JSON.stringify(!switched.ok && switched.error));
  assert.equal(s.actor, 'gardener');
  assert.match(switched.value, /writes as gardener/);
  assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'alice'), undefined, 'alice is free again');
  const blocked = await guardToolCall(t.context, s, write(alice));
  assert.ok(!blocked.allowed && blocked.reason.includes(join(t.vault.worktrees, 'gardener')), JSON.stringify(blocked));
  assert.deepEqual(await guardToolCall(t.context, s, write(join(t.vault.worktrees, 'gardener', 'a.md'))), { allowed: true });
  assert.equal((await actorHold(t.context.state, t.context.alive, 'home', 'gardener'))?.holder.session, 'pi-session-1');
}, OTHERS));

test('uncommitted work stays in the old actor\'s worktree, and the switch says how to commit it there', withInstallation(async (t) => {
  const s = await outside(t);
  const worktree = join(t.vault.worktrees, 'alice');
  assert.deepEqual(await guardToolCall(t.context, s, write(join(worktree, 'a.md'))), { allowed: true });
  writeFileSync(join(worktree, 'a.md'), 'draft');
  const switched = await switchActor(t.context, s, 'gardener');
  assert.ok(switched.ok);
  assert.match(switched.value, /home: 1 uncommitted change\(s\) stay in alice's worktree/);
  assert.ok(switched.value.includes(`cd ${worktree}`), switched.value);
  assert.match(switched.value, /vault commit home --actor alice/);
}, OTHERS));

test('a name that writes in no vault is refused, and the session stays as it was', withInstallation(async (t) => {
  const s = await outside(t);
  assert.deepEqual(await guardToolCall(t.context, s, write(join(t.vault.worktrees, 'alice', 'a.md'))), { allowed: true });
  const refused = await switchActor(t.context, s, 'mallory');
  assert.deepEqual(!refused.ok && refused.error, { reason: 'writes-nowhere', actor: 'mallory' });
  assert.match(switchRefusalText(!refused.ok ? refused.error : { reason: 'headless' }), /mallory writes in no registered vault/);
  assert.equal(s.actor, 'alice');
  assert.ok(s.holds.has('home'));
}, OTHERS));

test('a session in a vault takes the new actor\'s hold there at once, and reports one another session has', withInstallation(async (t) => {
  const s = await openTestSession(t);
  assert.ok(s.holds.has('home'));
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'gardener', holder: OTHER_HOLDER })).ok);
  const switched = await switchActor(t.context, s, 'gardener');
  assert.ok(switched.ok);
  assert.match(switched.value, /gardener is held by session other-session/);
  assert.equal(s.holds.size, 0);
  assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'alice'), undefined);
}, { running: RUNNING }));

test('a headless run cannot change its actor', withInstallation(async (t) => {
  const s = await openTestSession(t, { run: runOf(startedSpawn(t)) });
  const refused = await switchActor(t.context, s, 'alice');
  assert.deepEqual(!refused.ok && refused.error, { reason: 'headless' });
  assert.equal(s.actor, 'gardener');
}, { running: RUNNING }));

test('a headless run writes in no vault but its own', withInstallation(async (t) => {
  const s = await openTestSession(t, { run: runOf(startedSpawn(t)) });
  const { vault } = work(t);
  const blocked = await guardToolCall(t.context, s, write(join(vault.worktrees, 'gardener', 'a.md')));
  assert.ok(!blocked.allowed && /A job writes only in its own vault/.test(blocked.reason), JSON.stringify(blocked));
  assert.ok(!blocked.allowed && !/\/vault actor/.test(blocked.reason), 'a run has no person to ask');
}, { ...OTHERS, others: [{ id: 'work', contract: { id: 'work', owners: ['bob'], actors: ['gardener'] } }] }));
