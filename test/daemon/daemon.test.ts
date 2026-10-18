// Documented behaviour: daemon.md — one per machine ("Single instance": it
// binds its socket on start, and does not run if another daemon holds it);
// "Start-up recovery" before anything else; "Socket protocol" — JSON lines
// over a socket only the user can reach; "Git events" — a hook in each vault
// tells it refs changed. The daemon adapter only keeps time, sockets and
// processes; the decisions are the core's (automation). A fake pi stands in
// for Pi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allot } from '../../src/core/budgets/index.ts';
import { enqueueSpawn, listSpawns, startSpawn } from '../../src/core/queue/index.ts';
import { connectSocket, requestOver, requestOverSocket } from '../../src/core/socket/index.ts';
import { startDaemon, type DaemonOptions } from '../../src/daemon/daemon.ts';
import { daemonOptions, fakePi, jobDocument } from '../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../support/installation.ts';
import { ME, OTHER, RUNNING } from '../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'Unix domain sockets in tests' : false };

function options(t: TestInstallation, extra: Partial<DaemonOptions> = {}): DaemonOptions {
  return daemonOptions(t, fakePi(t, { '*': 'nothing' }), extra);
}

function job(t: TestInstallation): void {
  t.repo.write('jobs/a.md', jobDocument('[{ on: external, name: go, effect: spawn }]'));
  t.accept(t.repo.commit('job'));
}

test('one daemon runs: a second is refused while the first holds its record and socket', posixOnly, withInstallation(async (t) => {
  const first = await startDaemon(options(t));
  assert.ok(first.ok, JSON.stringify(!first.ok && first.error));
  try {
    const second = await startDaemon(options(t, { pid: OTHER }));
    assert.deepEqual(!second.ok && second.error, { reason: 'already-running', pid: ME });
    const ping = await requestOverSocket(t.installation.paths.socket, 'ping', {});
    assert.ok(ping.ok && (ping.value as { capabilities: string[] }).capabilities.includes('spawn'));
  } finally {
    await first.value.stop();
  }
  assert.equal(existsSync(t.installation.paths.socket), false, 'the socket is gone once it stops');
  const again = await startDaemon(options(t, { pid: OTHER }));
  assert.ok(again.ok, 'free once the first has stopped');
  await again.value.stop();
}, { running: RUNNING }));

test('a spawn sent over the socket runs, and its session is told when it starts and finishes', posixOnly, withInstallation(async (t) => {
  job(t);
  const daemon = await startDaemon(options(t));
  assert.ok(daemon.ok);
  try {
    const link = await connectSocket(t.installation.paths.socket);
    assert.ok(link.ok);
    const notices: { state: string }[] = [];
    const finished = new Promise<void>((resolve) => link.value.onMessage((m) => {
      const message = m as { notice?: string; state: string };
      if (message.notice !== 'spawn') return;
      notices.push(message);
      if (message.state === 'finished') resolve();
    }));
    const root = '01JR00T0000000000000000000';
    t.context.state.transaction((tx) => allot(tx, t.installation.config.budgets, t.clock, { trace: root, budget: { tokens: 1_000_000, ttlMs: 0 } }));
    assert.ok((await requestOver(link.value, 'subscribe', { trace: root })).ok);
    const sent = await requestOver(link.value, 'spawn', {
      vault: 'home', document: 'jobs/a.md', condition: 0, event: { kind: 'external', vault: 'home', name: 'go', id: 'E1' }, parent: root,
    });
    assert.ok(sent.ok, JSON.stringify(sent));
    await finished;
    assert.deepEqual(notices.map((n) => n.state), ['started', 'finished']);
    link.value.close();
    await daemon.value.automation.idle();
    assert.deepEqual(listSpawns(t.context.state).map((s) => s.state), ['recorded']);
  } finally {
    await daemon.value.stop();
  }
}, { running: RUNNING }));

test('word from a vault\'s hook that its refs changed makes the daemon look at that vault', posixOnly, withInstallation(async (t) => {
  t.repo.write('jobs/watch.md', jobDocument('[{ on: merged, effect: spawn }]'));
  t.accept(t.repo.commit('job'));
  const daemon = await startDaemon(options(t, { watch: true, pi: fakePi(t, { '*': 'hang' }).options.pi }));
  assert.ok(daemon.ok);
  try {
    t.repo.write('n.md', 'news');
    t.accept(t.repo.commit('news'));
    mkdirSync(t.installation.paths.refs, { recursive: true });
    writeFileSync(join(t.installation.paths.refs, 'home'), '');
    // The watcher is the operating system's: wait, boundedly, for the daemon to have looked.
    for (let i = 0; i < 100 && listSpawns(t.context.state).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(listSpawns(t.context.state).map((s) => s.document), ['jobs/watch.md']);
  } finally {
    await daemon.value.stop();
  }
}, { running: RUNNING, host: true }));

test('the daemon recovers before anything else: a spawn left running is stopped as restarted', posixOnly, withInstallation(async (t) => {
  job(t);
  const { entry } = enqueueSpawn(t.context.state, { ids: t.context.ids, clock: t.clock, limits: t.installation.config.budgets }, {
    vault: 'home', document: 'jobs/a.md', event: { kind: 'manual', id: 'M' }, budget: { tokens: 10, ttlMs: 60_000 }, actor: 'gardener',
  });
  assert.ok(startSpawn(t.context.state, t.clock, entry.id).ok);
  const daemon = await startDaemon(options(t));
  assert.ok(daemon.ok);
  try {
    assert.deepEqual(daemon.value.recovered.stopped, [entry.id]);
    assert.deepEqual(listSpawns(t.context.state).map((s) => [s.state, s.reason]), [['stopped', 'restart']]);
  } finally {
    await daemon.value.stop();
  }
}, { running: RUNNING }));
