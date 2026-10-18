// End to end: a scheduled job producing a
// proposal, which an owner reviews and accepts. Across the daemon (timers,
// claims, scheduling, `pi --mode rpc` in the actor's worktree — a fake pi
// that commits with the package's trailers), the actor branch as the
// proposal (concepts.md "Actor"), and the CLI: `vault status`, `vault
// review`, `vault accept` (cli.md "Proposals"; security.md — accept merges
// exactly the reviewed SHA, under the merge policy from the accepted main).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSpawns } from '../../src/core/queue/index.ts';
import { cliFor } from '../support/cli.ts';
import { fakePi, jobDocument, withDaemon } from '../support/daemon.ts';
import { withInstallation } from '../support/installation.ts';
import { RUNNING } from '../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'the daemon\'s Unix domain socket in tests' : false };
const HOUR = 3_600_000;
const MERGE = 'merge:\n  - { paths: ["**"], require: [checks, owner] }';

test('a timer job runs at its time and proposes; the owner accepts only what they reviewed; it runs once a day', posixOnly, withInstallation(async (t) => {
  const vault = cliFor(t);
  t.repo.write('jobs/digest.md', jobDocument('[{ on: timer, schedule: "0 6 * * *", effect: spawn }]', { body: 'Write the morning digest.' }));
  t.accept(t.repo.commit('A morning digest job'));

  const before = t.repo.git('rev-parse', 'main');
  await withDaemon(t, fakePi(t, { 'jobs/digest.md': 'commit' }), async (_daemon, minute) => {
    await minute();
    assert.deepEqual(listSpawns(t.context.state), [], 'not yet its time');
    t.clock.advance(6 * HOUR);
    await minute();
    const [spawn] = listSpawns(t.context.state);
    assert.ok(spawn !== undefined);
    assert.deepEqual([spawn.document, spawn.event.kind, spawn.state, spawn.actor], ['jobs/digest.md', 'timer', 'recorded', 'gardener']);
    const head = t.repo.git('rev-parse', 'actor/gardener');
    assert.equal(spawn.commit, head);
    assert.equal(t.repo.git('rev-parse', 'main'), before, 'a run never touches main');

    const status = await vault('status');
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`proposal from gardener: 1 commit\\(s\\), head ${head}`));

    assert.equal((await vault('accept', 'gardener')).code, 3, 'nothing reviewed yet: refused');
    const reviewed = await vault('review', 'gardener');
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.match(reviewed.stdout, new RegExp(`notes/${spawn.trace}\\.md`));

    // A commit after the review is not what the owner saw: accept refuses until it is reviewed too.
    const worktree = join(t.vault.worktrees, 'gardener');
    writeFileSync(join(worktree, 'notes', 'later.md'), '# Later\n');
    assert.equal((await cliFor(t, { cwd: worktree })('commit', '-m', 'Later')).code, 0);
    const moved = await vault('accept', 'gardener');
    assert.equal(moved.code, 3);
    assert.match(moved.stderr + moved.stdout, /moved since it was reviewed/);
    assert.equal(t.repo.git('rev-parse', 'main'), before, 'nothing merged');
    assert.equal((await vault('review', 'gardener')).code, 0);
    const accepted = await vault('accept', 'gardener');
    assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
    const main = t.repo.git('rev-parse', 'main');
    const reviewedHead = t.repo.git('rev-parse', 'actor/gardener');
    assert.equal(t.repo.git('merge-base', '--is-ancestor', reviewedHead, main), '', 'the reviewed head is in main');
    assert.equal(t.repo.git('ls-tree', '--name-only', main, 'notes/later.md'), 'notes/later.md');
    assert.match(t.repo.git('log', '-1', '--format=%(trailers)', head), new RegExp(`Vault-Trace: ${spawn.trace}\\nVault-Actor: gardener`));
    const read = await vault('read', `notes/${spawn.trace}.md`);
    assert.match(read.stdout, new RegExp(`Done by ${spawn.trace}`));
    assert.doesNotMatch((await vault('status')).stdout, /proposal from gardener/, 'nothing pending once accepted');

    t.clock.advance(HOUR);
    await minute();
    assert.equal(listSpawns(t.context.state).length, 1, 'once per slot: not again that day');
    t.clock.advance(23 * HOUR);
    await minute();
    assert.equal(listSpawns(t.context.state).length, 2, 'and again the next morning');
  });
}, { host: true, running: RUNNING, contract: { extra: MERGE } }));
