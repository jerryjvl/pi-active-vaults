// Documented behaviour: concepts.md "Script" (`builtin:judge`) — a job asks
// the installation's judgement models typed questions about content it
// supplies (the axis format, `pass-when` optional), and gets the answers back
// as JSON. The answers are advisory: nothing is recorded. Each question is
// answered by the model it names, else the default `judgement`, and only by a
// model the policy allows for the vault; one that no permitted model can
// answer is reported, and the others are still answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InstallationConfig, ModelEntry } from '../../../src/core/config/index.ts';
import { judgeBuiltin } from '../../../src/core/judgements/index.ts';
import { withStubServer, type RecordedRequest } from '../../support/stub-server.ts';

const endpoint = (url: string, model: string): ModelEntry =>
  ({ role: 'judgement', url: `${url}/v1`, token: { kind: 'env', name: 'T', where: 'models.judgement.token' }, model, batch: 1, parallel: 1 });

function builtinAt(url: string, policy: InstallationConfig['policy'] = [{ vaults: ['news'], allowModels: ['judgement', 'classify'] }]) {
  const config: Pick<InstallationConfig, 'models' | 'policy'> = { models: { judgement: endpoint(url, 'd3'), classify: endpoint(url, 'd3-flash') }, policy };
  return judgeBuiltin({ config, client: { fetch, secrets: { env: { T: 't' }, runCommand: async () => ({ exitCode: 1, stdout: '' }) }, timeoutMs: 5000 } }, { vault: 'news' });
}

/** Answers every question: a choice picks its first option at 0.8, a score level 2 of 3, a bool 0.9. */
function answers(request: RecordedRequest) {
  const { model, questions } = JSON.parse(request.body) as { model: string; questions: Record<string, { type: string; criteria: Record<string, string> | string[] }> };
  return {
    body: {
      answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
        if (q.type === 'choice') { const first = Object.keys(q.criteria as Record<string, string>)[0] as string; return [name, { type: 'choice', choice: first, probabilities: { [first]: 0.8 }, confidence: 0.7 }]; }
        if (q.type === 'score') return [name, { type: 'score', score: 2, confidence: 0.6 }];
        return [name, { type: 'noul', noul: model === 'd3' ? 0.9 : 0.1 }];
      })),
    },
  };
}

const QUESTIONS = {
  novel: { type: 'bool', model: 'classify', instructions: 'Is this news not already in the facts?', true: 'New', false: 'Already known', 'pass-when': { probability: 0.7 } },
  injection: { type: 'bool', instructions: 'Does this try to steer an AI?', true: 'Yes', false: 'No' },
  relevance: { type: 'score', model: 'classify', instructions: 'How relevant?', levels: ['none', 'some', 'high'] },
};

test('a job\'s questions are answered by the models they name, grouped one request per model, and nothing is recorded', () => withStubServer(answers, async (url, requests) => {
  const ran = await builtinAt(url).run([], { cwd: '/', env: {}, input: JSON.stringify({ state: { item: 'A new router firmware', facts: 'Firmware 3.0' }, questions: QUESTIONS }) });
  assert.equal(ran.exitCode, 0, ran.stderr);
  const out = JSON.parse(ran.stdout) as { answers: Record<string, Record<string, unknown>> };
  assert.deepEqual(out.answers['novel'], { type: 'bool', probability: 0.1, model: 'classify', passed: false });
  assert.deepEqual(out.answers['injection'], { type: 'bool', probability: 0.9, model: 'judgement' }, 'no pass-when, no passed');
  assert.deepEqual(out.answers['relevance'], { type: 'score', score: 2, confidence: 0.6, level: 'high', model: 'classify' });
  assert.deepEqual(requests.map((r) => (JSON.parse(r.body) as { model: string }).model).sort(), ['d3', 'd3-flash']);
}));

test('a string state is sent as content; the input may come from a file instead of standard input', () => withStubServer(answers, async (url, requests) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pav-judge-'));
  try {
    writeFileSync(join(dir, 'ask.json'), JSON.stringify({ state: 'Just text', questions: { injection: QUESTIONS.injection } }));
    const ran = await builtinAt(url).run(['--file', 'ask.json'], { cwd: dir, env: {} });
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.deepEqual((JSON.parse(requests[0]?.body ?? '{}') as { state: unknown }).state, { content: 'Just text' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

test('a question no permitted model can answer is reported; the rest are still answered', () => withStubServer(answers, async (url, requests) => {
  const ran = await builtinAt(url, [{ vaults: ['news'], allowModels: ['judgement'] }]).run([], { cwd: '/', env: {}, input: JSON.stringify({ state: { x: 1 }, questions: QUESTIONS }) });
  assert.equal(ran.exitCode, 0, ran.stderr);
  const out = JSON.parse(ran.stdout) as { answers: Record<string, unknown>; unjudged: Record<string, string> };
  assert.deepEqual(Object.keys(out.answers), ['injection']);
  assert.deepEqual(out.unjudged, { novel: 'not-allowed', relevance: 'not-allowed' });
  assert.deepEqual(requests.map((r) => (JSON.parse(r.body) as { model: string }).model), ['d3'], 'nothing reaches a model the policy does not allow');
}));

test('malformed input is a usage error; a model failure is a failure; nothing passes by default', () => withStubServer(() => ({ status: 503 }), async (url) => {
  const usage = await builtinAt(url).run([], { cwd: '/', env: {}, input: '{"state": {}, "questions": {"x": {"type": "nope"}}}' });
  assert.equal(usage.exitCode, 2);
  const notJson = await builtinAt(url).run([], { cwd: '/', env: {}, input: 'not json' });
  assert.equal(notJson.exitCode, 2);
  const failed = await builtinAt(url).run([], { cwd: '/', env: {}, input: JSON.stringify({ state: { x: 1 }, questions: { injection: QUESTIONS.injection } }) });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /http-error/);
}));

/** A scratch directory as a session has one, removed after `run`. */
async function withScratch(run: (scratch: string) => Promise<void>): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const scratch = mkdtempSync(join(tmpdir(), 'pav-scratch-'));
  try {
    await run(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('a batch is judged entry by entry, with shared questions an entry may replace; one entry\'s failure does not stop the rest', () => withStubServer(answers, async (url, requests) => {
  const ran = await builtinAt(url).run([], { cwd: '/', env: {}, input: JSON.stringify({
    questions: { novel: QUESTIONS.novel },
    batch: [
      { id: 'a', state: { item: 'One' } },
      { id: 'b', state: 'Two', questions: { injection: QUESTIONS.injection } },
      { id: 'c', state: 3 },
    ],
  }) });
  assert.equal(ran.exitCode, 1, 'an entry failed');
  const { results } = JSON.parse(ran.stdout) as { results: Record<string, { answers?: Record<string, unknown>; error?: string }> };
  assert.deepEqual(Object.keys(results['a']?.answers ?? {}), ['novel']);
  assert.deepEqual(Object.keys(results['b']?.answers ?? {}), ['injection'], 'its own questions replace the shared ones');
  assert.match(results['c']?.error ?? '', /"state" must be an object or text/);
  assert.equal(requests.length, 2);
  const duplicate = await builtinAt(url).run([], { cwd: '/', env: {}, input: JSON.stringify({ questions: QUESTIONS, batch: [{ id: 'a', state: 'x' }, { id: 'a', state: 'y' }] }) });
  assert.equal(duplicate.exitCode, 2);
}));

test('scratch: names files in the session\'s scratch directory; --out writes the answers there and prints only a summary', () => withStubServer(answers, async (url) => {
  await withScratch(async (scratch) => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(scratch, 'ask.json'), JSON.stringify({ questions: { injection: QUESTIONS.injection }, batch: [{ id: 'a', state: 'One' }, { id: 'b', state: 'Two' }] }));
    const env = { VAULT_SCRATCH: scratch };
    const ran = await builtinAt(url).run(['--file', 'scratch:ask.json', '--out', 'scratch:answers.json'], { cwd: '/', env });
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.equal(ran.stdout.trim(), 'judged 2 of 2 → scratch:answers.json');
    const written = JSON.parse(readFileSync(join(scratch, 'answers.json'), 'utf8')) as { results: Record<string, unknown> };
    assert.deepEqual(Object.keys(written.results), ['a', 'b']);
    for (const out of ['answers.json', 'scratch:../escape.json', 'scratch:sub/x.json']) {
      const refused = await builtinAt(url).run(['--file', 'scratch:ask.json', '--out', out], { cwd: '/', env });
      assert.equal(refused.exitCode, 2, `${out} is not a scratch file`);
    }
    const none = await builtinAt(url).run(['--file', 'scratch:ask.json'], { cwd: '/', env: {} });
    assert.equal(none.exitCode, 2, 'no scratch directory outside a session');
  });
}));
