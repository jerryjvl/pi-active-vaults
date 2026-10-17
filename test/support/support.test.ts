// The shared test support must itself behave: later stages build on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeClock, fakeIds } from './clock.ts';
import { createTempRepo } from './git-repo.ts';
import { startStubServer } from './stub-server.ts';

test('fake clock only moves when advanced', () => {
  const clock = fakeClock('2026-03-01T12:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-03-01T12:00:00.000Z');
  clock.advance(1500);
  assert.equal(clock.now().toISOString(), '2026-03-01T12:00:01.500Z');
});

test('fake IDs are sequential and time-sortable as strings', () => {
  const ids = fakeIds();
  const issued = [ids.next('t'), ids.next('t'), ids.next('t')];
  assert.deepEqual(issued, ['t-0001', 't-0002', 't-0003']);
  assert.deepEqual([...issued].sort(), issued);
});

test('temp repo commits files on main, independent of global Git config, and cleans up', () => {
  const repo = createTempRepo();
  try {
    repo.write('notes/a.md', '# A\n');
    const sha = repo.commit('Add a');
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(repo.git('log', '-1', '--format=%an <%ae>'), 'Alice <alice@example.net>');
    assert.equal(repo.git('status', '--porcelain'), '');
  } finally {
    repo.cleanup();
  }
  assert.equal(existsSync(repo.path), false);
});

test('stub server records requests and serves JSON from the handler', async () => {
  const server = await startStubServer((req) => ({ body: { echoed: req.body } }));
  try {
    const response = await fetch(`${server.url}/v1/echo`, { method: 'POST', body: 'hi' });
    assert.deepEqual(await response.json(), { echoed: 'hi' });
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.method, 'POST');
    assert.equal(server.requests[0]!.url, '/v1/echo');
  } finally {
    await server.close();
  }
});

test('stub server reports handler failures as 500', async () => {
  const server = await startStubServer(() => {
    throw new Error('boom');
  });
  try {
    assert.equal((await fetch(server.url)).status, 500);
  } finally {
    await server.close();
  }
});
