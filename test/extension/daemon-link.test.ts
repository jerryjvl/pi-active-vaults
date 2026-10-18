// Documented behaviour: extension.md "Session lifecycle" — at session start
// the extension connects to the daemon if one is running; "Spawns" — a
// session's spawn requests are sent there (queued in the state database
// otherwise), and the session receives a short notice when spawned work
// starts and finishes; api.md "Events" — `pav:v1:spawn` with the state.
// Tested through Pi 1.3.0's SDK, against a daemon running a fake pi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGit } from '../../src/core/git/index.ts';
import { createIdSource } from '../../src/core/ids/index.ts';
import { listSpawns } from '../../src/core/queue/index.ts';
import { startDaemon } from '../../src/daemon/daemon.ts';
import { fakePi, jobDocument } from '../support/daemon.ts';
import { withInstallation } from '../support/installation.ts';
import { DONE, withPi } from '../support/pi.ts';
import { OTHER, RUNNING } from '../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'Unix domain sockets in tests' : false };

test('with a daemon running, a session\'s spawns go to it, and the session is told when they start and finish', posixOnly, withInstallation(async (t) => {
  t.repo.write('jobs/greet.md', jobDocument('[{ on: session.start, effect: spawn }]'));
  t.accept(t.repo.commit('job'));
  const pi = fakePi(t, { '*': 'nothing' });
  const daemon = await startDaemon({
    host: t.host, pid: OTHER, pi: pi.options.pi, env: pi.options.env, timeZone: 'UTC', ticks: false, watch: false,
    context: { git: createGit({ env: t.repo.env }), clock: t.clock, ids: createIdSource({ clock: t.clock, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }), alive: t.context.alive, sandbox: 'none' },
  });
  assert.ok(daemon.ok, JSON.stringify(!daemon.ok && daemon.error));
  try {
    await withPi(t, { flags: { 'vault-actor': 'alice' } }, async (session) => {
      for (let i = 0; i < 300 && !session.events.some((e) => e.channel === 'pav:v1:spawn' && (e.data as { state: string }).state === 'finished'); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const states = session.events.filter((e) => e.channel === 'pav:v1:spawn').map((e) => (e.data as { state: string }).state);
      assert.deepEqual(states, ['requested', 'started', 'finished']);
      assert.ok(session.notices.some((n) => /jobs\/greet\.md.*started/.test(n.text)), JSON.stringify(session.notices));
      assert.ok(session.notices.some((n) => /jobs\/greet\.md.*finished/.test(n.text)));
      session.respond(DONE);
      await session.prompt('Hello.');
    });
    assert.equal(pi.starts().length, 1, 'the daemon ran it');
    assert.deepEqual(listSpawns(t.context.state).map((s) => s.state), ['recorded']);
  } finally {
    await daemon.value.stop();
  }
}, { running: RUNNING }));
