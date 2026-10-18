// Documented behaviour: concepts.md "Installation", core.md `models`,
// principles 10 and 11 — a model role is a configured URL, token and model ID;
// an unconfigured role disables its feature without an error; the
// installation's `policy` records which roles may receive each vault's
// content; `embed` speaks the OpenAI-compatible `POST /v1/embeddings` and
// `rerank` `POST /v1/rerank`; work is split into batches of the role's `batch`
// size, sent up to `parallel` at a time. Secrets never appear in errors. Only
// local stub servers are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InstallationConfig, ModelEndpoint, SecretDeps } from '../../../src/core/config/index.ts';
import { embed, inBatches, modelFor, rerank, type ModelClient } from '../../../src/core/models/index.ts';
import { startStubServer, type StubHandler, withStubServer } from '../../support/stub-server.ts';

const TOKEN = 's3cret-token';

function endpoint(url: string, overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return { url: `${url}/v1`, token: { kind: 'env', name: 'MODEL_TOKEN', where: 'models.embed.token' }, model: 'test-model', batch: 1, parallel: 1, ...overrides };
}

function config(models: InstallationConfig['models'], policy: InstallationConfig['policy']): Pick<InstallationConfig, 'models' | 'policy'> {
  return { models, policy };
}

const secrets: SecretDeps = { env: { MODEL_TOKEN: TOKEN }, runCommand: async () => assert.fail('no command') };
const client = (overrides: Partial<ModelClient> = {}): ModelClient => ({ fetch, secrets, timeoutMs: 5000, ...overrides });

const vector = (text: string): number[] => [text.length, text.charCodeAt(0)];

const embeddings: StubHandler = (request) => {
  const { input } = JSON.parse(request.body) as { input: string[] };
  // Deliberately out of order: the client must place each vector by its index.
  return { body: { data: input.map((text, index) => ({ index, embedding: vector(text) })).reverse() } };
};

test('an unconfigured role is disabled, not an error to the caller\'s feature', () => {
  const found = modelFor(config({}, [{ vaults: ['home'], allowModels: ['embed'] }]), 'embed', ['home']);
  assert.deepEqual(found, { ok: false, error: { reason: 'unconfigured', role: 'embed' } });
});

test('a role receives a vault\'s content only where the installation\'s policy allows it', () => {
  const models = { embed: endpoint('http://127.0.0.1:1'), rerank: endpoint('http://127.0.0.1:1') };
  const policy = [{ vaults: ['home'], allowModels: ['embed' as const] }, { vaults: ['home', 'work'], allowModels: ['rerank' as const] }];
  assert.ok(modelFor(config(models, policy), 'embed', ['home']).ok);
  assert.ok(modelFor(config(models, policy), 'rerank', ['home', 'work']).ok, 'allowed by different entries');
  assert.deepEqual(modelFor(config(models, policy), 'embed', ['home', 'work']), { ok: false, error: { reason: 'not-allowed', role: 'embed', vault: 'work' } });
  assert.deepEqual(modelFor(config(models, []), 'embed', ['home']), { ok: false, error: { reason: 'not-allowed', role: 'embed', vault: 'home' } }, 'no policy allows nothing');
  assert.ok(modelFor(config(models, []), 'embed', []).ok, 'no vault content involved');
});

test('batches of `batch` inputs run at most `parallel` at a time, and results keep the input order', async () => {
  let running = 0;
  let most = 0;
  const sizes: number[] = [];
  const results = await inBatches([1, 2, 3, 4, 5, 6, 7], { batch: 2, parallel: 3 }, async (items) => {
    running++;
    most = Math.max(most, running);
    sizes.push(items.length);
    await new Promise<void>((resolve) => setImmediate(resolve));
    running--;
    return { ok: true as const, value: items.map((n) => n * 10) };
  });
  assert.deepEqual(results, { ok: true, value: [10, 20, 30, 40, 50, 60, 70] });
  assert.deepEqual(sizes.sort(), [1, 2, 2, 2]);
  assert.equal(most, 3);
});

test('a failing batch fails the whole call, and no further batches start', async () => {
  const started: number[] = [];
  const results = await inBatches([1, 2, 3, 4, 5], { batch: 1, parallel: 1 }, async ([n = 0]) => {
    started.push(n);
    return n === 2 ? { ok: false as const, error: 'boom' } : { ok: true as const, value: [n] };
  });
  assert.deepEqual(results, { ok: false, error: 'boom' });
  assert.deepEqual(started, [1, 2]);
});

test('embed posts batches to /v1/embeddings with the token and model, and returns vectors in input order', async () => {
  await withStubServer(embeddings, async (url, requests) => {
    const permitted = modelFor(config({ embed: endpoint(url, { batch: 2, parallel: 2 }) }, [{ vaults: ['home'], allowModels: ['embed'] }]), 'embed', ['home']);
    assert.ok(permitted.ok);
    const texts = ['alpha', 'be', 'gamma', 'd', 'epsilon'];
    const vectors = await embed(client(), permitted.value, texts);
    assert.deepEqual(vectors, { ok: true, value: texts.map(vector) });
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/embeddings');
      assert.equal(request.headers['authorization'], `Bearer ${TOKEN}`);
      assert.equal((JSON.parse(request.body) as { model: string }).model, 'test-model');
    }
    assert.deepEqual(requests.map((r) => (JSON.parse(r.body) as { input: string[] }).input).sort(), [['alpha', 'be'], ['epsilon'], ['gamma', 'd']]);
  });
});

test('rerank posts batches to /v1/rerank and returns each document\'s score in input order', async () => {
  const handler: StubHandler = (request) => {
    const { query, documents, top_n } = JSON.parse(request.body) as { query: string; documents: string[]; top_n: number };
    assert.equal(query, 'router');
    assert.equal(top_n, documents.length);
    return { body: { results: documents.map((d, index) => ({ index, relevance_score: d.includes('router') ? 0.9 : 0.1 })).reverse() } };
  };
  await withStubServer(handler, async (url, requests) => {
    const permitted = modelFor(config({ rerank: endpoint(url, { batch: 2 }) }, [{ vaults: ['home'], allowModels: ['rerank'] }]), 'rerank', ['home']);
    assert.ok(permitted.ok);
    const scores = await rerank(client(), permitted.value, 'router', ['the router', 'a switch', 'router config']);
    assert.deepEqual(scores, { ok: true, value: [0.9, 0.1, 0.9] });
    assert.deepEqual(requests.map((r) => r.url), ['/v1/rerank', '/v1/rerank']);
  });
});

test('failures are error values that name the role and never the token', async () => {
  const cases: [StubHandler, string][] = [
    [() => ({ status: 500, body: `upstream failed for ${TOKEN}` }), 'http-error'],
    [() => ({ body: { data: [{ index: 0, embedding: ['x'] }] } }), 'bad-response'],
    [() => ({ body: { data: [] } }), 'bad-response'],
    [() => ({ body: { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [1] }] } }), 'bad-response'],
    [() => ({ body: 'not json' }), 'bad-response'],
  ];
  for (const [handler, reason] of cases) {
    await withStubServer(handler, async (url) => {
      const permitted = modelFor(config({ embed: endpoint(url, { batch: 2 }) }, [{ vaults: ['home'], allowModels: ['embed'] }]), 'embed', ['home']);
      assert.ok(permitted.ok);
      const result = await embed(client(), permitted.value, ['a', 'b']);
      assert.ok(!result.ok, reason);
      assert.equal(result.error.reason, reason);
      assert.ok(!JSON.stringify(result.error).includes(TOKEN));
    });
  }
});

test('an unreachable endpoint, a slow one and an unresolvable token each fail closed', async () => {
  const policy = [{ vaults: ['home'], allowModels: ['embed' as const] }];
  const closed = await startStubServer(() => ({}));
  await closed.close();
  const unreachable = modelFor(config({ embed: endpoint(closed.url) }, policy), 'embed', ['home']);
  assert.ok(unreachable.ok);
  assert.deepEqual(await embed(client(), unreachable.value, ['a']), { ok: false, error: { reason: 'unreachable', role: 'embed' } });

  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await withStubServer(async () => { await held; return { body: { data: [] } }; }, async (url) => {
    const slow = modelFor(config({ embed: endpoint(url) }, policy), 'embed', ['home']);
    assert.ok(slow.ok);
    assert.deepEqual(await embed(client({ timeoutMs: 50 }), slow.value, ['a']), { ok: false, error: { reason: 'timed-out', role: 'embed' } });
    release();
  });

  const noToken = modelFor(config({ embed: endpoint('http://127.0.0.1:1') }, policy), 'embed', ['home']);
  assert.ok(noToken.ok);
  const unresolved = await embed(client({ secrets: { env: {}, runCommand: secrets.runCommand } }), noToken.value, ['a']);
  assert.deepEqual(unresolved, { ok: false, error: { reason: 'token', role: 'embed', where: 'models.embed.token' } });
});

test('the token is resolved once per call, not once per batch', async () => {
  let resolved = 0;
  const counting: SecretDeps = { env: {}, runCommand: async () => { resolved++; return { exitCode: 0, stdout: TOKEN }; } };
  await withStubServer(embeddings, async (url) => {
    const permitted = modelFor(config({ embed: endpoint(url, { token: { kind: 'command', command: 'lookup', where: 'models.embed.token' } }) }, [{ vaults: ['home'], allowModels: ['embed'] }]), 'embed', ['home']);
    assert.ok(permitted.ok);
    assert.ok((await embed(client({ secrets: counting }), permitted.value, ['a', 'b', 'c'])).ok);
    assert.equal(resolved, 1);
  });
});

test('nothing is sent for no inputs', async () => {
  await withStubServer(embeddings, async (url, requests) => {
    const permitted = modelFor(config({ embed: endpoint(url) }, [{ vaults: ['home'], allowModels: ['embed'] }]), 'embed', ['home']);
    assert.ok(permitted.ok);
    assert.deepEqual(await embed(client(), permitted.value, []), { ok: true, value: [] });
    assert.equal(requests.length, 0);
  });
});

test('a redirect is an error naming the role, and the content never reaches the redirect\'s target', async () => {
  // core.md `models`: requests never follow redirects, so vault content goes
  // only to the configured URL — a 307 or 308 would otherwise resend the body.
  await withStubServer(embeddings, async (elsewhere, received) => {
    for (const status of [301, 302, 303, 307, 308]) {
      await withStubServer(() => ({ status, headers: { location: `${elsewhere}/v1/embeddings` } }), async (url) => {
        const policy = [{ vaults: ['home'], allowModels: ['embed' as const, 'rerank' as const] }];
        const embedder = modelFor(config({ embed: endpoint(url) }, policy), 'embed', ['home']);
        const reranker = modelFor(config({ rerank: endpoint(url) }, policy), 'rerank', ['home']);
        assert.ok(embedder.ok && reranker.ok);
        assert.deepEqual(await embed(client(), embedder.value, ['private text']), { ok: false, error: { reason: 'redirected', role: 'embed', status } });
        assert.deepEqual(await rerank(client(), reranker.value, 'q', ['private text']), { ok: false, error: { reason: 'redirected', role: 'rerank', status } });
      });
    }
    assert.equal(received.length, 0, 'nothing reached the redirect target');
  });
});
