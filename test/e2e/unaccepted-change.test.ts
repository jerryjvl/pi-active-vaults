// End to end (implementation plan, Stage 7): an unaccepted change pausing
// automation, then accept --adopt and the alternative, resetting main
// (security.md "Unexpected changes"; daemon.md "Integrity"; cli.md — every
// command reports it, and adopting shows the delta's concerns, which must be
// acknowledged, then the delta, which must be confirmed). Across a commit
// made straight onto main, the daemon (pause, the owner told once through
// the outbox, catch-up once adopted) and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listSpawns } from '../../src/core/queue/index.ts';
import { cliFor } from '../support/cli.ts';
import { fakePi, jobDocument, withDaemon } from '../support/daemon.ts';
import { withInstallation } from '../support/installation.ts';
import { RUNNING } from '../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'the daemon\'s Unix domain socket in tests' : false };
const NOTIFY = 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { alice: alice@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }';
const WATCH = '[{ on: merged, paths: ["notes/**"], effect: spawn }]';

test('a commit straight onto main pauses the vault until the owner adopts it, acknowledging its concerns; then its events are matched', posixOnly, withInstallation(async (t) => {
  const vault = cliFor(t);
  t.repo.write('jobs/watch.md', jobDocument(WATCH));
  t.accept(t.repo.commit('A job watching notes'));

  await withDaemon(t, fakePi(t, { '*': 'nothing' }), async (_daemon, minute) => {
    await minute();
    t.repo.write('notes/stray.md', '# Stray\n');
    // Widening what the job matches is a control change: a concern the owner must acknowledge.
    t.repo.write('jobs/watch.md', jobDocument('[{ on: merged, paths: ["notes/**", "ideas/**"], effect: spawn }]'));
    const stray = t.repo.commit('Straight onto main, not through review');

    await minute();
    await minute();
    assert.deepEqual(listSpawns(t.context.state), [], 'paused: nothing matched');
    const jobs = await vault('jobs');
    assert.match(jobs.stderr, /main has 1 unaccepted commit.*Automation is paused/, 'every command says so');
    const run = await vault('run', 'jobs/watch.md');
    assert.equal(run.code, 3, 'a propagating action is refused');
    const status = await vault('status');
    assert.equal(status.stdout.match(/an unaccepted change to main/g)?.length, 1, 'the owner told once (undelivered here, so it shows)');

    const shown = await vault('accept', '--adopt', stray);
    assert.equal(shown.code, 3, 'no terminal to confirm at: shown, not adopted');
    assert.match(shown.stderr, /jobs\/watch\.md/, 'the control change is a concern');
    const digest = /--acknowledge ([0-9a-f]{64})/.exec(shown.stdout + shown.stderr)?.[1];
    assert.ok(digest !== undefined);
    assert.equal((await vault('accept', '--adopt', stray, '--yes')).code, 3, 'confirming without acknowledging the concerns is refused');
    const adopted = await vault('accept', '--adopt', stray, '--acknowledge', digest, '--yes');
    assert.equal(adopted.code, 0, adopted.stdout + adopted.stderr);
    assert.equal((await vault('jobs')).stderr, '', 'nothing unaccepted any more');

    await minute();
    const spawns = listSpawns(t.context.state);
    assert.deepEqual(spawns.map((s) => [s.document, s.event.kind, 'commit' in s.event ? s.event.commit : undefined, s.state]), [
      ['jobs/watch.md', 'merged', stray, 'recorded'],
    ], 'caught up once adopted');
  });
}, { host: true, running: RUNNING, config: NOTIFY }));

test('resetting main to the accepted main also resumes the vault, and the discarded commit is never matched', posixOnly, withInstallation(async (t) => {
  const vault = cliFor(t);
  t.repo.write('jobs/watch.md', jobDocument(WATCH));
  const accepted = t.accept(t.repo.commit('A job watching notes')).sha;

  await withDaemon(t, fakePi(t, { '*': 'nothing' }), async (_daemon, minute) => {
    await minute();
    t.repo.write('notes/stray.md', '# Stray\n');
    t.repo.commit('Straight onto main');
    await minute();
    assert.match((await vault('status')).stderr, /unaccepted commit/);

    t.repo.git('reset', '--quiet', '--hard', accepted);
    await minute();
    assert.equal((await vault('status')).stderr, '', 'resolved');
    t.repo.write('notes/kept.md', '# Kept\n');
    const kept = t.repo.commit('A note, accepted');
    t.accept(kept);
    await minute();
    assert.deepEqual(listSpawns(t.context.state).map((s) => 'commit' in s.event ? s.event.commit : undefined), [kept], 'only the accepted commit\'s event');
  });
}, { host: true, running: RUNNING }));
