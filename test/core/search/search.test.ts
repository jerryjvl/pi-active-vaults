// Documented behaviour: core.md "Search", security.md, architecture.md
// "Degradation", concepts.md `index` — one index per installation with the
// vault as a column, built from Git up to the accepted `main` (an index update
// is a propagating action: refused while `main` has an unaccepted change);
// contracts decide whether a subtree is searched (`default`, `opt-in`, `none`);
// keyword and vector results are fused by rank, then reranked when a rerank
// model is configured; each hit is checked against the accepted `main`
// (`current`, `changed`, `moved`, `gone`); the index records its embedding
// model, and a different model needs a rebuild; without an embedding model
// search is keyword-only, reported as such. Models get a vault's content only
// where the installation's policy allows. Only local stub servers are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InstallationConfig, ModelEndpoint, ModelRole } from '../../../src/core/config/index.ts';
import { recordAccepted, type VaultLocation } from '../../../src/core/integrity/index.ts';
import type { ModelClient } from '../../../src/core/models/index.ts';
import { INDEX_MODULES, openIndexStore } from '../../../src/core/operations/index.ts';
import { search, updateIndex, type SearchContext, type SearchRequest } from '../../../src/core/search/index.ts';
import { INDEX_FILE, openStore, type Store } from '../../../src/core/store/index.ts';
import { createTempRepo, gitFor } from '../../support/git-repo.ts';
import { startStubServer, type StubHandler, type StubServer } from '../../support/stub-server.ts';
import { createTempDir } from '../../support/temp-dir.ts';
import { rootContract, withTestVault, type TestVault } from '../../support/vault.ts';

// Words in one group share a dimension, so "automobile" is near "car" though no keyword matches.
const GROUPS = [['car', 'cars', 'automobile', 'vehicle', 'brakes'], ['router', 'network', 'hall'], ['garden', 'plant', 'tomatoes']];

function wordVector(text: string): number[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return [...GROUPS.map((group) => words.filter((w) => group.includes(w)).length), 0.01];
}

const embeddings: StubHandler = (request) => {
  const { input } = JSON.parse(request.body) as { input: string[] };
  return { body: { data: input.map((text, index) => ({ index, embedding: wordVector(text) })) } };
};

/** Scores a document higher the more often it mentions "hall". */
const hallReranker: StubHandler = (request) => {
  const { documents } = JSON.parse(request.body) as { documents: string[] };
  return { body: { results: documents.map((d, index) => ({ index, relevance_score: (d.match(/hall/g) ?? []).length })) } };
};

interface Fixture {
  readonly v: TestVault;
  readonly index: Store;
  /** The search context with the given model roles configured at the stub's URL and allowed for `allowed` vaults. */
  context(roles?: Partial<Record<ModelRole, { url: string; model?: string }>>, allowed?: readonly string[]): SearchContext;
}

function withSearch(run: (f: Fixture) => Promise<void>, options: { vectorExtension?: string } = {}): () => Promise<void> {
  return withTestVault(async (v) => {
    const dir = createTempDir('pav-index-');
    const opened = options.vectorExtension === undefined
      ? openIndexStore({ indexDb: dir.file('index.sqlite') })
      : openStore(dir.file('index.sqlite'), INDEX_FILE, INDEX_MODULES, { vectorExtension: options.vectorExtension });
    if (!opened.ok) assert.fail(JSON.stringify(opened.error));
    const index = opened.value;
    const context = (roles: Partial<Record<ModelRole, { url: string; model?: string }>> = {}, allowed: readonly string[] = ['home', 'work']): SearchContext => {
      const models: Partial<Record<ModelRole, ModelEndpoint>> = {};
      for (const [role, { url, model }] of Object.entries(roles) as [ModelRole, { url: string; model?: string }][]) {
        models[role] = { url: `${url}/v1`, token: { kind: 'env', name: 'TOKEN', where: `models.${role}.token` }, model: model ?? `${role}-model`, batch: 4, parallel: 2 };
      }
      const config: Pick<InstallationConfig, 'models' | 'policy'> = {
        models,
        policy: allowed.length === 0 ? [] : [{ vaults: [...allowed], allowModels: ['embed', 'rerank'] }],
      };
      const client: ModelClient = { fetch, secrets: { env: { TOKEN: 't' }, runCommand: async () => ({ exitCode: 1, stdout: '' }) }, timeoutMs: 5000 };
      return { git: v.git, state: v.store, index, clock: v.clock, models: { client, config } };
    };
    try {
      await run({ v, index, context });
    } finally {
      index.close();
      dir.cleanup();
    }
  });
}

async function withStubs(handlers: Partial<Record<'embed' | 'rerank', StubHandler>>, run: (stubs: Partial<Record<'embed' | 'rerank', StubServer>>) => Promise<void>): Promise<void> {
  const stubs: Partial<Record<'embed' | 'rerank', StubServer>> = {};
  try {
    for (const [role, handler] of Object.entries(handlers) as ['embed' | 'rerank', StubHandler][]) stubs[role] = await startStubServer(handler);
    await run(stubs);
  } finally {
    for (const stub of Object.values(stubs)) await stub.close();
  }
}

async function indexed(context: SearchContext, vault: VaultLocation) {
  const report = await updateIndex(context, vault);
  if (!report.ok) assert.fail(`index update failed: ${JSON.stringify(report.error)}`);
  return report.value;
}

async function found(context: SearchContext, request: SearchRequest) {
  const result = await search(context, request);
  if (!result.ok) assert.fail(`search failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

test('documents are searchable as committed in the accepted main, never from the working tree', withSearch(async ({ v, context }) => {
  v.repo.write('topics/router.md', '# Router\nThe router sits in the hall cupboard.');
  v.repo.commit('router');
  v.accept();
  v.repo.write('topics/draft.md', 'router notes not yet committed');
  const report = await indexed(context(), v.vault);
  assert.deepEqual([report.added, report.vectors], [['_contract.md', 'topics/router.md'], { state: 'none', reason: 'no-embed-model' }]);
  const result = await found(context(), { query: 'router', vaults: [v.vault] });
  assert.equal(result.mode, 'keyword');
  assert.deepEqual(result.notes, [{ kind: 'keyword-only', reason: 'no-embed-model' }]);
  assert.deepEqual(result.hits.map((h) => [h.vault, h.path, h.heading, h.freshness]), [['home', 'topics/router.md', ['Router'], 'current']]);
  assert.match(result.hits[0]?.excerpt ?? '', /router sits in the hall/);
}));

test('an index update is refused while main has an unaccepted change, and the index is left as it was', withSearch(async ({ v, context }) => {
  v.repo.write('a.md', 'lantern');
  v.repo.commit('a');
  v.accept();
  await indexed(context(), v.vault);
  v.repo.write('b.md', 'lantern on an unaccepted commit');
  v.repo.commit('stray commit on main');
  const refused = await updateIndex(context(), v.vault);
  assert.equal(!refused.ok && refused.error.reason, 'unaccepted-change');
  const result = await found(context(), { query: 'lantern', vaults: [v.vault] });
  assert.deepEqual(result.hits.map((h) => h.path), ['a.md'], 'search continues on what was indexed');
}));

test('contracts decide what is searched: `none` never, `opt-in` only within a scope; .vault/ and non-documents never', withSearch(async ({ v, context }) => {
  v.repo.write('topics/zebra.md', 'A zebra.');
  v.repo.write('private/_contract.md', '---\nindex: none\n---\n');
  v.repo.write('private/zebra.md', 'A private zebra.');
  v.repo.write('archive/_contract.md', '---\nindex: opt-in\n---\n');
  v.repo.write('archive/zebra.md', 'An archived zebra.');
  v.repo.write('.vault/zebra.md', 'A package zebra.');
  v.repo.write('topics/zebra.txt', 'A text zebra.');
  v.repo.commit('zebras');
  v.accept();
  await indexed(context(), v.vault);
  const paths = async (scope?: string) =>
    (await found(context(), { query: 'zebra', vaults: [v.vault], ...(scope === undefined ? {} : { scope }) })).hits.map((h) => h.path).sort();
  assert.deepEqual(await paths(), ['topics/zebra.md']);
  assert.deepEqual(await paths('archive/**'), ['archive/zebra.md']);
  assert.deepEqual(await paths('private/**'), []);
  assert.deepEqual(await paths('**'), ['archive/zebra.md', 'topics/zebra.md']);
}));

test('an index whose contract cannot be read leaves that subtree out', withSearch(async ({ v, context }) => {
  v.repo.write('topics/_contract.md', '---\nindex: [unclosed\n---\n');
  v.repo.write('topics/zebra.md', 'A zebra.');
  v.repo.write('zebra.md', 'Another zebra.');
  v.repo.commit('zebras');
  v.accept();
  const report = await indexed(context(), v.vault);
  assert.deepEqual(report.skipped, [{ path: 'topics/_contract.md', reason: 'invalid-contract' }, { path: 'topics/zebra.md', reason: 'invalid-contract' }]);
  assert.deepEqual((await found(context(), { query: 'zebra', vaults: [v.vault] })).hits.map((h) => h.path), ['zebra.md']);
}));

test('each hit is checked against the current accepted main: changed, moved or gone', withSearch(async ({ v, context }) => {
  for (const name of ['a', 'b', 'c', 'd']) v.repo.write(`${name}.md`, `The ${name} lantern, with enough words to follow a rename.`);
  v.repo.commit('lanterns');
  v.accept();
  await indexed(context(), v.vault);
  v.repo.write('a.md', 'The a lantern, changed.');
  v.repo.git('mv', 'b.md', 'b2.md');
  v.repo.git('rm', '--quiet', 'c.md');
  v.repo.commit('change, move and remove');
  v.accept();
  const before = await found(context(), { query: 'lantern', vaults: [v.vault] });
  assert.deepEqual(
    before.hits.map((h) => [h.path, h.freshness, h.movedTo]).sort(),
    [['a.md', 'changed', undefined], ['b.md', 'moved', 'b2.md'], ['c.md', 'gone', undefined], ['d.md', 'current', undefined]],
  );
  const report = await indexed(context(), v.vault);
  assert.deepEqual([report.added, report.changed, report.removed], [['b2.md'], ['a.md'], ['b.md', 'c.md']]);
  const after = await found(context(), { query: 'lantern', vaults: [v.vault] });
  assert.deepEqual(after.hits.map((h) => [h.path, h.freshness]).sort(), [['a.md', 'current'], ['b2.md', 'current'], ['d.md', 'current']]);
}));

test('search covers only the vaults asked for, and says which of them are not indexed', withSearch(async ({ v, context }) => {
  v.repo.write('home.md', 'kettle at home');
  v.repo.commit('home');
  v.accept();
  const repo = createTempRepo();
  try {
    repo.write('_contract.md', rootContract({ id: 'work' }));
    repo.write('work.md', 'kettle at work');
    const sha = repo.commit('work vault');
    const accepted = recordAccepted(v.store, 'work', { sha, how: 'init', by: 'alice', at: v.clock.now() }, null);
    assert.ok(accepted.ok);
    const work = { id: 'work', path: repo.path };
    const workContext = { ...context(), git: gitFor(repo) };
    await indexed(context(), v.vault);
    assert.deepEqual((await found(context(), { query: 'kettle', vaults: [v.vault] })).hits.map((h) => h.vault), ['home']);
    const notYet = await found(context(), { query: 'kettle', vaults: [v.vault, work] });
    assert.deepEqual(notYet.notes.filter((n) => n.kind === 'not-indexed'), [{ kind: 'not-indexed', vault: 'work' }]);
    await indexed(workContext, work);
    assert.deepEqual((await found(context(), { query: 'kettle', vaults: [work] })).hits.map((h) => h.vault), ['work']);
  } finally {
    repo.cleanup();
  }
}));

test('with an embedding model, vectors find what keywords miss, and keyword and vector ranks are fused', withSearch(async ({ v, context }) => {
  v.repo.write('cars.md', '# Car\nMy car needs new brakes.');
  v.repo.write('garden.md', '# Garden\nPlant tomatoes in spring.');
  v.repo.commit('notes');
  v.accept();
  await withStubs({ embed: embeddings }, async ({ embed }) => {
    const roles = { embed: { url: embed!.url } };
    const report = await indexed(context(roles), v.vault);
    assert.deepEqual(report.vectors, { state: 'complete' });
    const sent = embed!.requests.flatMap((r) => (JSON.parse(r.body) as { input: string[] }).input);
    assert.ok(sent.includes('home · Car · Car\n\nMy car needs new brakes.'), 'each chunk is embedded with its header');
    const vectorOnly = await found(context(roles), { query: 'automobile', vaults: [v.vault] });
    assert.equal(vectorOnly.mode, 'hybrid');
    assert.deepEqual(vectorOnly.notes, []);
    assert.equal(vectorOnly.hits[0]?.path, 'cars.md');
    const both = await found(context(roles), { query: 'brakes', vaults: [v.vault] });
    assert.equal(both.hits[0]?.path, 'cars.md');
  });
}));

test('no vault content reaches a model the policy does not allow; search falls back to keywords', withSearch(async ({ v, context }) => {
  v.repo.write('cars.md', 'My car needs new brakes.');
  v.repo.commit('notes');
  v.accept();
  await withStubs({ embed: embeddings, rerank: hallReranker }, async ({ embed, rerank }) => {
    const roles = { embed: { url: embed!.url }, rerank: { url: rerank!.url } };
    const report = await indexed(context(roles, []), v.vault);
    assert.deepEqual(report.vectors, { state: 'none', reason: 'not-allowed' });
    const result = await found(context(roles, []), { query: 'brakes', vaults: [v.vault] });
    assert.equal(result.mode, 'keyword');
    assert.equal(result.reranked, false);
    assert.deepEqual(result.notes, [{ kind: 'keyword-only', reason: 'not-allowed' }, { kind: 'not-reranked', reason: 'not-allowed' }]);
    assert.deepEqual(result.hits.map((h) => h.path), ['cars.md']);
    assert.equal(embed!.requests.length + rerank!.requests.length, 0);
  });
}));

test('an embedding model that fails at query time leaves keyword results, reported as such', withSearch(async ({ v, context }) => {
  v.repo.write('cars.md', 'My car needs new brakes.');
  v.repo.commit('notes');
  v.accept();
  let failing = false;
  await withStubs({ embed: (r) => (failing ? { status: 503 } : embeddings(r)) }, async ({ embed }) => {
    const roles = { embed: { url: embed!.url } };
    await indexed(context(roles), v.vault);
    failing = true;
    const result = await found(context(roles), { query: 'brakes', vaults: [v.vault] });
    assert.equal(result.mode, 'keyword');
    assert.deepEqual(result.notes, [{ kind: 'keyword-only', reason: 'embed-failed' }]);
    assert.deepEqual(result.hits.map((h) => h.path), ['cars.md']);
    const report = await indexed(context(roles), v.vault);
    assert.equal(report.vectors.state, 'complete', 'nothing new to embed');
  });
}));

test('the index records its embedding model; a different model searches by keyword until the index is rebuilt', withSearch(async ({ v, context }) => {
  v.repo.write('cars.md', 'My car needs new brakes.');
  v.repo.commit('notes');
  v.accept();
  await withStubs({ embed: embeddings }, async ({ embed }) => {
    await indexed(context({ embed: { url: embed!.url, model: 'model-a' } }), v.vault);
    const other = context({ embed: { url: embed!.url, model: 'model-b' } });
    const stale = await found(other, { query: 'automobile', vaults: [v.vault] });
    assert.deepEqual([stale.mode, stale.notes], ['keyword', [{ kind: 'keyword-only', reason: 'model-changed' }]]);
    const rebuilt = await indexed(other, v.vault);
    assert.deepEqual(rebuilt.vectors, { state: 'complete' });
    const fresh = await found(other, { query: 'automobile', vaults: [v.vault] });
    assert.deepEqual([fresh.mode, fresh.hits[0]?.path], ['hybrid', 'cars.md']);
  });
}));

test('a rerank model, where allowed, reorders the fused results', withSearch(async ({ v, context }) => {
  v.repo.write('a.md', 'The router config, router settings, router everything.');
  v.repo.write('b.md', 'A router in the hall, by the hall door.');
  v.repo.commit('routers');
  v.accept();
  await indexed(context(), v.vault);
  const plain = await found(context(), { query: 'router', vaults: [v.vault] });
  assert.deepEqual(plain.hits.map((h) => h.path), ['a.md', 'b.md']);
  await withStubs({ rerank: hallReranker }, async ({ rerank }) => {
    const result = await found(context({ rerank: { url: rerank!.url } }), { query: 'router', vaults: [v.vault] });
    assert.equal(result.reranked, true);
    assert.deepEqual(result.hits.map((h) => h.path), ['b.md', 'a.md']);
  });
}));

test('without the vector extension, indexing and search work on keywords alone', withSearch(async ({ v, context }) => {
  v.repo.write('cars.md', 'My car needs new brakes.');
  v.repo.commit('notes');
  v.accept();
  await withStubs({ embed: embeddings }, async ({ embed }) => {
    const roles = { embed: { url: embed!.url } };
    const report = await indexed(context(roles), v.vault);
    assert.deepEqual(report.vectors, { state: 'none', reason: 'no-vector-extension' });
    const result = await found(context(roles), { query: 'brakes', vaults: [v.vault] });
    assert.deepEqual([result.mode, result.notes, result.hits.map((h) => h.path)], ['keyword', [{ kind: 'keyword-only', reason: 'no-vector-extension' }], ['cars.md']]);
    assert.equal(embed!.requests.length, 0);
  });
}, { vectorExtension: '/nonexistent/vec0.so' }));

test('query text is matched as words, never as search syntax; an empty query is refused', withSearch(async ({ v, context }) => {
  v.repo.write('a.md', 'Quotes "and" stars* and NEAR(things).');
  v.repo.commit('a');
  v.accept();
  await indexed(context(), v.vault);
  for (const query of ['"and"', 'stars*', 'NEAR(things)', 'AND OR NOT', 'col:umn', '^start']) {
    assert.ok((await search(context(), { query, vaults: [v.vault] })).ok, query);
  }
  assert.deepEqual((await found(context(), { query: 'NEAR(things)', vaults: [v.vault] })).hits.map((h) => h.path), ['a.md']);
  const empty = await search(context(), { query: '  ?! ', vaults: [v.vault] });
  assert.deepEqual(!empty.ok && empty.error, { reason: 'empty-query' });
}));
