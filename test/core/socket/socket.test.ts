// Documented behaviour: daemon.md "Single instance" and "Socket protocol" —
// the daemon binds its socket on start, and if another daemon already holds
// it, does not run; the protocol is JSON lines over a local socket accessible
// only to the user (a Unix domain socket; a named pipe on Windows).
// architecture.md "Data locations" — the socket lives in `<state>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { connectSocket, listenSocket, requestOverSocket, type Channel } from '../../../src/core/socket/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'Unix domain sockets' : false };

/** Answers `{ id, method }` with `{ id, ok, result: method }`. */
function echo(channel: Channel): void {
  channel.onMessage((message) => {
    const { id, method } = message as { id: string; method: string };
    channel.send({ id, ok: true, result: method });
  });
}

test('one listener holds the socket; a second is refused while it runs', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('daemon.sock');
  const first = await listenSocket(path, echo);
  assert.ok(first.ok, JSON.stringify(first));
  try {
    const second = await listenSocket(path, echo);
    assert.deepEqual(!second.ok && second.error, { reason: 'in-use' });
    assert.equal(await requestOverSocket(path, 'ping', {}).then((r) => r.ok && r.value), 'ping', 'the first still answers');
  } finally {
    await first.value.close();
  }
}));

test('a socket left by a listener that has gone is taken over', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('daemon.sock');
  // A listener that crashes leaves its socket file behind.
  const crashed = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => crashed.stdout.once('data', resolve));
  crashed.kill('SIGKILL');
  await new Promise((resolve) => crashed.once('exit', resolve));
  assert.ok(existsSync(path), 'a stale socket file');
  const again = await listenSocket(path, echo);
  assert.ok(again.ok, JSON.stringify(again));
  await again.value.close();
}));

test('a file in the socket\'s place that is not a socket is never removed', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('daemon.sock');
  writeFileSync(path, 'mine');
  const refused = await listenSocket(path, echo);
  assert.deepEqual(!refused.ok && refused.error.reason, 'not-a-socket');
  assert.ok(existsSync(path));
}));

test('the socket is accessible only to the user', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('daemon.sock');
  const server = await listenSocket(path, echo);
  assert.ok(server.ok);
  try {
    assert.equal(statSync(path).mode & 0o077, 0);
  } finally {
    await server.value.close();
  }
}));

test('messages are JSON lines; a request is answered by its ID', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('daemon.sock');
  const server = await listenSocket(path, (channel) => channel.onMessage((message) => {
    const { id } = message as { id: string };
    channel.send({ notice: 'first' });
    channel.send({ id, ok: true, result: { text: 'line separator\nnewline' } });
  }));
  assert.ok(server.ok);
  try {
    const client = await connectSocket(path);
    assert.ok(client.ok);
    const received: unknown[] = [];
    client.value.onMessage((m) => received.push(m));
    const answered = await requestOverSocket(path, 'status', {});
    assert.deepEqual(answered, { ok: true, value: { text: 'line separator\nnewline' } });
    client.value.close();
  } finally {
    await server.value.close();
  }
}));

test('with nothing listening, a request says so as a value', posixOnly, withTempDir(async (dir) => {
  const answered = await requestOverSocket(dir.file('daemon.sock'), 'ping', {});
  assert.deepEqual(!answered.ok && answered.error.reason, 'not-running');
}));

test('a refused request is a value carrying its reason', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('daemon.sock');
  const server = await listenSocket(path, (channel) => channel.onMessage((message) => {
    channel.send({ id: (message as { id: string }).id, ok: false, error: { reason: 'unknown-method' } });
  }));
  assert.ok(server.ok);
  try {
    assert.deepEqual(await requestOverSocket(path, 'nonsense', {}), { ok: false, error: { reason: 'refused', error: { reason: 'unknown-method' } } });
  } finally {
    await server.value.close();
  }
}));
