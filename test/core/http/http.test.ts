// Documented behaviour: core.md `http` — a JSON request goes only to the URL
// given (redirects are errors, never followed), within a time limit, and an
// error carries a status at most, never the response body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../../../src/core/http/index.ts';
import { withStubServer } from '../../support/stub-server.ts';

const client = { fetch, timeoutMs: 5000 };

test('a JSON body is sent and the JSON response returned; an empty response has no body', async () => {
  await withStubServer((request) => (request.method === 'PUT' ? { status: 204 } : { status: 201, body: { echoed: JSON.parse(request.body) } }), async (url) => {
    assert.deepEqual(await requestJson(client, { method: 'POST', url, headers: { authorization: 'token t' }, body: { a: 1 } }), {
      ok: true, value: { status: 201, body: { echoed: { a: 1 } } },
    });
    assert.deepEqual(await requestJson(client, { method: 'PUT', url, headers: {} }), { ok: true, value: { status: 204, body: undefined } });
  });
});

test('a redirect is never followed, whatever the method', async () => {
  let followed = 0;
  await withStubServer(() => { followed++; return { body: {} }; }, async (target) => {
    await withStubServer(() => ({ status: 307, headers: { location: target } }), async (url) => {
      for (const method of ['GET', 'POST'] as const) {
        assert.deepEqual(await requestJson(client, { method, url, headers: { authorization: 'Bearer secret' }, body: method === 'POST' ? {} : undefined }), {
          ok: false, error: { reason: 'redirected', status: 307 },
        });
      }
    });
  });
  assert.equal(followed, 0);
});

test('an error status, a body that is not JSON and a slow response are errors without the body', async () => {
  await withStubServer(() => ({ status: 404, body: 'secret echoed back' }), async (url) => {
    assert.deepEqual(await requestJson(client, { method: 'GET', url, headers: {} }), { ok: false, error: { reason: 'http-error', status: 404 } });
  });
  await withStubServer(() => ({ body: 'secret, not json' }), async (url) => {
    assert.deepEqual(await requestJson(client, { method: 'GET', url, headers: {} }), { ok: false, error: { reason: 'bad-response', detail: 'not JSON' } });
  });
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await withStubServer(async () => { await held; return { body: {} }; }, async (url) => {
    assert.deepEqual(await requestJson({ fetch, timeoutMs: 50 }, { method: 'GET', url, headers: {} }), { ok: false, error: { reason: 'timed-out' } });
    release();
  });
});
