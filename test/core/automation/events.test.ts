// Documented behaviour: daemon.md "Matching" — events are derived from each
// job's cursor up to the accepted main and matched against `applies-when`;
// "Matching" — nothing is lost while the daemon is down; "Spawn lifecycle" — each
// spawn is claimed once; "Integrity" — an unaccepted change pauses the
// vault's automation, and the owner is notified once, as of a branch that
// would conflict with the accepted main; "Hosting" — only a
// vault this installation hosts (or is the executor of) runs its jobs here.
// concepts.md "Session tree" — work a run commits stays in its tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureActorWorktree } from '../../../src/core/actors/index.ts';
import { acceptedMain, recordAccepted } from '../../../src/core/integrity/index.ts';
import { listSpawns } from '../../../src/core/queue/index.ts';
import { automationFor, fakePi, jobDocument } from '../../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { PACKAGE_TRAILERS, rootContract } from '../../support/vault.ts';

const ON_NOTES = '[{ on: merged, paths: ["notes/**"], effect: spawn }]';

function accepted(t: TestInstallation, message: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) t.repo.write(path, text);
  const sha = t.repo.commit(message);
  t.accept(sha);
  return sha;
}

const claimed = (t: TestInstallation) => listSpawns(t.context.state).map((s) => [s.document, s.event.kind, 'commit' in s.event ? s.event.commit : undefined]);

test('merged events since a job\'s cursor are claimed in order; nothing is claimed twice', withInstallation(async (t) => {
  accepted(t, 'job', { 'jobs/watch.md': jobDocument(ON_NOTES) });
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  const first = accepted(t, 'a note', { 'notes/a.md': 'A' });
  accepted(t, 'elsewhere', { 'other/x.md': 'X' });
  const third = accepted(t, 'b note', { 'notes/b.md': 'B' });
  await automation.tick();
  await automation.tick();
  assert.deepEqual(claimed(t), [['jobs/watch.md', 'merged', first], ['jobs/watch.md', 'merged', third]]);
}, { host: true }));

test('a job accepted while the daemon was down catches up from the merge that brought it', withInstallation(async (t) => {
  const before = automationFor(t, fakePi(t));
  await before.start();
  await before.stop();
  accepted(t, 'job', { 'jobs/watch.md': jobDocument(ON_NOTES) });
  const note = accepted(t, 'a note, while no daemon runs', { 'notes/a.md': 'A' });
  const after = automationFor(t, fakePi(t));
  await after.start();
  assert.deepEqual(claimed(t), [['jobs/watch.md', 'merged', note]]);
}, { host: true }));

test('a vault a daemon takes up starts from where its history is: nothing before is replayed', withInstallation(async (t) => {
  accepted(t, 'job', { 'jobs/watch.md': jobDocument(ON_NOTES) });
  accepted(t, 'a note, before any daemon', { 'notes/a.md': 'A' });
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  assert.deepEqual(claimed(t), []);
}, { host: true }));

test('an unaccepted change pauses the vault: nothing is claimed, and the owner is told once; once adopted, the events are claimed', withInstallation(async (t) => {
  accepted(t, 'job', { 'jobs/watch.md': jobDocument(ON_NOTES) });
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  t.repo.write('notes/stray.md', 'stray');
  const stray = t.repo.commit('stray, not accepted');
  await automation.tick();
  await automation.tick();
  assert.deepEqual(claimed(t), []);
  const told = t.context.state.all<{ alias: string; subject: string }>('SELECT alias, subject FROM notify_outbox');
  assert.deepEqual(told.map((m) => m.alias), ['alice'], 'once, to the owner');
  assert.match(told[0]?.subject ?? '', /home/);
  t.accept(stray);
  await automation.tick();
  assert.deepEqual(claimed(t), [['jobs/watch.md', 'merged', stray]]);
}, {
  host: true,
  config: 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { alice: alice@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }',
}));

test('an actor branch that would conflict with the accepted main is told to the owner once, naming the paths', withInstallation(async (t) => {
  accepted(t, 'a note', { 'notes/a.md': 'base' });
  t.repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  t.repo.write('notes/a.md', 'the gardener');
  t.repo.commit(`gardener edit${PACKAGE_TRAILERS}`);
  t.repo.git('checkout', '--quiet', 'main');
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  accepted(t, 'elsewhere', { 'other/x.md': 'X' });
  await automation.tick();
  const conflicts = () => t.context.state.all<{ alias: string; subject: string; body: string }>("SELECT alias, subject, body FROM notify_outbox WHERE key LIKE 'conflict:%'");
  assert.deepEqual(conflicts(), [], 'a clean merge is not told');
  accepted(t, 'main edits the same note', { 'notes/a.md': 'main' });
  await automation.tick();
  await automation.tick();
  const told = conflicts();
  assert.deepEqual(told.map((m) => m.alias), ['alice'], 'once, to the owner');
  assert.match(told[0]?.subject ?? '', /actor\/gardener/);
  assert.match(told[0]?.body ?? '', /in: notes\/a\.md/);
}, {
  host: true,
  config: 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { alice: alice@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }',
}));

test('only a hosted vault, or one this installation is the executor of, runs its jobs here', withInstallation(async (t) => {
  accepted(t, 'job', { 'jobs/watch.md': jobDocument(ON_NOTES) });
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  accepted(t, 'a note', { 'notes/a.md': 'A' });
  await automation.tick();
  assert.deepEqual(claimed(t), [], 'not hosted');
  accepted(t, 'executor', { '_contract.md': rootContract().replace('  actors: [gardener]', '  actors: [gardener]\n  executor: alice@homeserver') });
  await automation.tick(); // taken up here: from now on
  accepted(t, 'another note', { 'notes/b.md': 'B' });
  await automation.tick();
  assert.deepEqual(claimed(t).map((c) => c[0]), ['jobs/watch.md'], 'the executor runs it whatever host says');
}));

test('commits on an actor branch are committed events; one already requested at the commit is the same spawn', withInstallation(async (t) => {
  accepted(t, 'job', { 'jobs/tidy.md': jobDocument('[{ on: committed, actor: [gardener], effect: spawn }]', { actor: 'librarian' }) });
  const main = acceptedMain(t.context.state, 'home');
  assert.ok(main !== undefined);
  const worktree = await ensureActorWorktree(t.context.git, t.vault, main, 'gardener');
  assert.ok(worktree.ok);
  const automation = automationFor(t, fakePi(t));
  await automation.start();

  writeFileSync(join(worktree.value.path, 'n.md'), 'through the package');
  const committed = await t.run('commit', { message: 'By gardener' }, { caller: { actor: 'gardener' } });
  assert.equal(committed.status, 'ok', committed.text);
  assert.equal(listSpawns(t.context.state).length, 1, 'requested at the commit');
  await automation.tick();
  assert.equal(listSpawns(t.context.state).length, 1, 'derived again by the daemon: the same spawn');

  writeFileSync(join(worktree.value.path, 'm.md'), 'by hand');
  t.repo.git('-C', worktree.value.path, 'add', 'm.md');
  t.repo.git('-C', worktree.value.path, 'commit', '--quiet', '-m', `By hand${PACKAGE_TRAILERS}`);
  await automation.tick();
  await automation.tick();
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.document, s.event.kind]), [['jobs/tidy.md', 'committed'], ['jobs/tidy.md', 'committed']]);
}, { host: true, contract: { actors: ['gardener', 'librarian'] } }));

test('a vault subscribed to another receives its merged events', withInstallation(async (t) => {
  t.repo.write('jobs/digest.md', jobDocument('[{ on: merged, effect: spawn }]'));
  t.accept(t.repo.commit('job'));
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  const other = t.others['digests'];
  assert.ok(other !== undefined);
  other.repo.write('d.md', 'news');
  const sha = other.repo.commit('news');
  assert.ok(recordAccepted(t.context.state, 'digests', { sha, how: 'accept', by: 'alice', at: t.clock.now() }, acceptedMain(t.context.state, 'digests')?.sha ?? null).ok);
  await automation.tick();
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.vault, s.document, 'vault' in s.event ? s.event.vault : '']), [['home', 'jobs/digest.md', 'digests']]);
}, { host: true, others: [{ id: 'digests' }], config: 'subscriptions:\n  - { from: digests, to: home }' }));
