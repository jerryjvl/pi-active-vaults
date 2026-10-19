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
