// Documented behaviour: mcp.md "Rules" — MCP endpoints are local: a loopback
// address and port, or a socket accessible only to the user; they do not
// terminate TLS. core.md `socket` — the one place the package listens: an
// HTTP endpoint is served there too, with the socket's rules (one listener,
// a stale socket taken over, nothing that is not a socket removed, 0600),
// and request bodies are bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { listenHttp } from '../../../src/core/socket/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'Unix domain sockets' : false };

/** Answers with the method, path, authorization and body it was sent. */
const echo = async (req: Request): Promise<Response> =>
  Response.json({ method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization'), body: await req.text() });

function send(target: { port?: number; socketPath?: string }, body: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ method: 'POST', host: '127.0.0.1', path: '/mcp?x=1', ...target, headers: { 'content-length': String(Buffer.byteLength(body)), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a loopback endpoint hands each request to the handler as a web request, and its answer back', async () => {
  const served = await listenHttp({ kind: 'tcp', host: '127.0.0.1', port: 0 }, echo, { maxBodyBytes: 1024 });
  assert.ok(served.ok, JSON.stringify(served));
  try {
    const port = Number(new URL(served.value.url).port);
    const answer = await send({ port }, 'hello', { authorization: 'Bearer x' });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { method: 'POST', path: '/mcp', authorization: 'Bearer x', body: 'hello' });
    assert.equal((await send({ port }, 'x'.repeat(2048))).status, 413, 'a body past the bound is refused before the handler');
  } finally {
    await served.value.close();
  }
});

test('a handler that throws is answered 500, saying nothing of why', async () => {
  const served = await listenHttp({ kind: 'tcp', host: '127.0.0.1', port: 0 }, async () => { throw new Error('secret detail'); }, { maxBodyBytes: 1024 });
  assert.ok(served.ok);
  try {
    const answer = await send({ port: Number(new URL(served.value.url).port) }, '');
    assert.equal(answer.status, 500);
    assert.ok(!answer.text.includes('secret detail'));
  } finally {
    await served.value.close();
  }
});

test('a socket endpoint follows the socket\'s rules: the user\'s only, one listener, nothing that is not a socket removed', posixOnly, withTempDir(async (dir) => {
  const path = dir.file('mcp.sock');
  const served = await listenHttp({ kind: 'path', path }, echo, { maxBodyBytes: 1024 });
  assert.ok(served.ok, JSON.stringify(served));
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((await send({ socketPath: path }, 'hi')).status, 200);
    const second = await listenHttp({ kind: 'path', path }, echo, { maxBodyBytes: 1024 });
    assert.deepEqual(!second.ok && second.error.reason, 'in-use');
  } finally {
    await served.value.close();
  }
  assert.equal(existsSync(path), false);
  writeFileSync(path, 'mine');
  const refused = await listenHttp({ kind: 'path', path }, echo, { maxBodyBytes: 1024 });
  assert.deepEqual(!refused.ok && refused.error.reason, 'not-a-socket');
  assert.ok(existsSync(path));
}));
