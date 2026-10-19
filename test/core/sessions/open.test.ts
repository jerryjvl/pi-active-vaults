// Documented behaviour: extension.md "Session lifecycle" and concepts.md
// "Actor" — a session determines its actor and budget at start and takes the
// actor's hold, or reports who holds it; a busy actor can be waited for; a
// session holds its actor through a record of its process, so an ended one
// holds nothing; shutdown releases it. An interactive session's actor is the
// one whose worktree it runs in, else the one given (`--vault-actor`), else
// the installation's person; a headless session takes actor, trace and the
// spawn's budget from the daemon's run file (api.md "Flags") and runs only
// with all of them (gates fail closed) — including the `agent` model it was
// started on, which must be one the policy allows for its vault and the model
// the session actually runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { actorHold, takeActorHold } from '../../../src/core/actors/index.ts';
import { budgetState } from '../../../src/core/budgets/index.ts';
import { eventJson } from '../../../src/core/conditions/index.ts';
import { closeSession, holdActor, openSession, type SessionStart } from '../../../src/core/sessions/index.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { AGENT_MODEL } from '../../support/models.ts';
import { ME, OTHER, OTHER_HOLDER, RUNNING, runOf, startedSpawn } from '../../support/session.ts';


function start(t: TestInstallation, extra: Partial<SessionStart> = {}): SessionStart {
  return { session: 'pi-session-1', pid: ME, cwd: t.repo.path, model: AGENT_MODEL, ...extra };
}

test('an interactive session in a vault writes as the installation\'s person, holds that actor, and has a budget in a tree of its own', withInstallation(async (t) => {
  const opened = await openSession(t.context, start(t));
  assert.ok(opened.ok, JSON.stringify(!opened.ok && opened.error));
  const { session } = opened.value;
  assert.equal(session.mode, 'interactive');
  assert.equal(session.vault?.id, 'home');
  assert.equal(session.actor, 'alice');
  assert.equal(session.worktree, join(t.vault.worktrees, 'alice'));
  assert.equal(session.held, true);
  assert.equal((await actorHold(t.context.state, t.context.alive, 'home', 'alice'))?.holder.session, 'pi-session-1');
  assert.match(session.trace, /^[0-9A-Z]{26}$/);
  assert.ok(budgetState(t.context.state, t.installation.config.budgets, t.clock, session.trace) !== undefined);
}, { running: RUNNING }));

test('the actor is the worktree\'s when the session runs in one, else the one asked for', withInstallation(async (t) => {
  const asked = await openSession(t.context, start(t, { actor: 'gardener' }));
  assert.ok(asked.ok);
  assert.equal(asked.value.session.actor, 'gardener');
  closeSession(t.context, asked.value.session);
  const worktree = join(t.vault.worktrees, 'gardener', 'notes');
  mkdirSync(worktree, { recursive: true });
  const inWorktree = await openSession(t.context, start(t, { session: 'pi-session-2', cwd: worktree, actor: 'alice' }));
  assert.ok(inWorktree.ok);
  assert.equal(inWorktree.value.session.actor, 'gardener');
}, { running: RUNNING }));

const live: Record<number, string> = { ...RUNNING };
test('an actor another session holds is reported with that session; the session can wait for it', withInstallation(async (t) => {
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'alice', holder: OTHER_HOLDER })).ok);
  const opened = await openSession(t.context, start(t));
  assert.ok(opened.ok);
  assert.equal(opened.value.session.held, false);
  assert.ok(opened.value.notices.some((n) => /alice.*held by session other-session/.test(n)), opened.value.notices.join('\n'));
  delete live[OTHER]; // the other session ends
  assert.ok((await holdActor(t.context, opened.value.session)).ok);
  assert.equal(opened.value.session.held, true);
}, { running: live }));

test('a session whose own process cannot be told holds nothing, and says so', withInstallation(async (t) => {
  const opened = await openSession(t.context, start(t, { pid: 99 }));
  assert.ok(opened.ok);
  assert.equal(opened.value.session.held, false);
  assert.ok(opened.value.notices.some((n) => /cannot hold/.test(n)), opened.value.notices.join('\n'));
  assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'alice'), undefined);
}, { running: RUNNING }));

test('an actor the vault does not have is no writer: the session holds nothing and has no worktree', withInstallation(async (t) => {
  const opened = await openSession(t.context, start(t, { actor: 'mallory' }));
  assert.ok(opened.ok);
  assert.equal(opened.value.session.held, false);
  assert.equal(opened.value.session.worktree, undefined);
  assert.ok(opened.value.notices.some((n) => /mallory is not one of the actors/.test(n)), opened.value.notices.join('\n'));
}, { running: RUNNING }));

test('a session outside every vault reads and writes nothing as an actor', withInstallation(async (t) => {
  const opened = await openSession(t.context, start(t, { cwd: t.dir.path }));
  assert.ok(opened.ok);
  assert.equal(opened.value.session.vault, undefined);
  assert.equal(opened.value.session.actor, undefined);
  assert.equal(opened.value.session.held, false);
}, { running: RUNNING }));

test('the start reports every vault with an unaccepted change', withInstallation(async (t) => {
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  const opened = await openSession(t.context, start(t));
  assert.ok(opened.ok);
  assert.ok(opened.value.notices.some((n) => /Vault "home": main has 1 unaccepted commit/.test(n)));
}, { running: RUNNING }));

test('closing releases the hold and ends the session\'s budget; closing twice is harmless', withInstallation(async (t) => {
  const opened = await openSession(t.context, start(t));
  assert.ok(opened.ok);
  const { session } = opened.value;
  closeSession(t.context, session);
  closeSession(t.context, session);
  assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'alice'), undefined);
  assert.equal(session.held, false);
}, { running: RUNNING }));

test('a headless session runs as the run file says: its vault, actor, trace and the spawn\'s budget', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const opened = await openSession(t.context, start(t, { run: runOf(entry) }));
  assert.ok(opened.ok, JSON.stringify(!opened.ok && opened.error));
  const { session } = opened.value;
  assert.equal(session.mode, 'headless');
  assert.equal(session.trace, entry.trace);
  assert.equal(session.actor, 'gardener');
  assert.equal(session.held, true);
  assert.equal(session.worktree, join(t.vault.worktrees, 'gardener'));
}, { running: RUNNING }));

test('a headless session without its spawn\'s budget, or whose actor is held, does not run', withInstallation(async (t) => {
  const run = { vault: 'home', document: 'jobs/daily.md', trace: '01JNOSUCHRUN00000000000000', actor: 'gardener', model: 'agent', event: { kind: 'manual' as const, id: 'M1' } };
  const unbudgeted = await openSession(t.context, start(t, { run }));
  assert.deepEqual(!unbudgeted.ok && unbudgeted.error.reason, 'no-allotment');
  const entry = startedSpawn(t);
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'gardener', holder: OTHER_HOLDER })).ok);
  const busy = await openSession(t.context, start(t, { run: { ...run, trace: entry.trace } }));
  assert.deepEqual(!busy.ok && busy.error.reason, 'actor-busy');
  const unknown = await openSession(t.context, start(t, { run: { ...run, trace: entry.trace, vault: 'nowhere' } }));
  assert.deepEqual(!unknown.ok && unknown.error.reason, 'unknown-vault');
}, { running: RUNNING }));

test('a headless run is briefed with its job as on the accepted main and the triggering event as data', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  t.repo.write('jobs/daily.md', '---\napplies-when: [{ on: external, name: x, effect: spawn }]\n---\nUnaccepted instructions.\n');
  t.repo.commit('unaccepted job change');
  const opened = await openSession(t.context, start(t, { run: runOf(entry) }));
  assert.ok(opened.ok, JSON.stringify(!opened.ok && opened.error));
  const brief = opened.value.session.brief ?? '';
  assert.match(brief, /<vault-job source="home:jobs\/daily\.md">\nRun the daily job\.\n<\/vault-job>/);
  assert.doesNotMatch(brief, /Unaccepted/);
  assert.ok(brief.includes(eventJson(entry.event)), brief);
}, { running: RUNNING }));

test('a headless run whose job is not on the accepted main does not run', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const opened = await openSession(t.context, start(t, { run: { ...runOf(entry), document: 'jobs/gone.md' } }));
  assert.deepEqual(!opened.ok && opened.error.reason, 'unknown-job');
}, { running: RUNNING }));

test('a headless run writes only as one of the vault\'s actors, never as an owner', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const opened = await openSession(t.context, start(t, { run: runOf(entry, 'alice') }));
  assert.deepEqual(!opened.ok && opened.error, { reason: 'not-a-vault-actor', vault: 'home', actor: 'alice' });
}, { running: RUNNING }));

// concepts.md "Models": policy applies to the model actually used — for a headless run, the one Pi is running it on.
test('a headless run starts only when its session runs on the agent model the daemon chose', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const wrong = await openSession(t.context, start(t, { run: runOf(entry), model: 'fake/other' }));
  assert.deepEqual(!wrong.ok && wrong.error, { reason: 'no-model', vault: 'home', model: 'agent' });
  const { model: _, ...unspoken } = start(t, { run: runOf(entry) });
  const unknown = await openSession(t.context, unspoken);
  assert.deepEqual(!unknown.ok && unknown.error.reason, 'no-model', 'a session that cannot say what model it runs on does not run a job');
  const right = await openSession(t.context, start(t, { run: runOf(entry) }));
  assert.ok(right.ok, JSON.stringify(!right.ok && right.error));
}, { running: RUNNING }));

test('a headless run on a model that is no longer configured, or no longer allowed for its vault, does not start; the default does not stand in', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const gone = await openSession(t.context, start(t, { run: { ...runOf(entry), model: 'quick' } }));
  assert.deepEqual(!gone.ok && gone.error, { reason: 'no-model', vault: 'home', model: 'quick' });
}, { running: RUNNING }));

test('a headless run whose model the policy does not allow for its vault does not start', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  const { installation } = t.context;
  const stricter = { ...t.context, installation: { ...installation, config: { ...installation.config, policy: [] } } };
  const refused = await openSession(stricter, start(t, { run: runOf(entry) }));
  assert.deepEqual(!refused.ok && refused.error, { reason: 'no-model', vault: 'home', model: 'agent' });
}, { running: RUNNING }));
