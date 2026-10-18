// Documented behaviour: core.md "Judgements" and concepts.md "Installation" —
// the judgement role speaks the System One protocol: one `POST <url>/systemone`
// with the model, the state and typed questions (`bool` is `noul` on the
// wire), answered with a typed answer per question and optional usage. A
// response missing an answer or with a wrong type fails; like every role, a
// redirect is an error and the token never appears in one. Local stubs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelEndpoint, SecretDeps } from '../../../src/core/config/index.ts';
import { askSystemOne, modelFor, type ModelClient, type SystemOneQuestion } from '../../../src/core/models/index.ts';
import { withStubServer } from '../../support/stub-server.ts';

const TOKEN = 'judge-token';
const secrets: SecretDeps = { env: { JUDGE_TOKEN: TOKEN }, runCommand: async () => assert.fail('no command') };
const client: ModelClient = { fetch, secrets, timeoutMs: 5000 };

function judge(url: string) {
  const endpoint: ModelEndpoint = { url: `${url}/v1`, token: { kind: 'env', name: 'JUDGE_TOKEN', where: 'models.judgement.token' }, model: 'laya', batch: 1, parallel: 1 };
  const permitted = modelFor({ models: { judgement: endpoint }, policy: [{ vaults: ['home'], allowModels: ['judgement'] }] }, 'judgement', ['home']);
  assert.ok(permitted.ok);
  return permitted.value;
}

const state = { vault: 'Home things.', path: 'topics/a.md', title: 'A', labels: ['cars'], content: 'text' };
const questions: Record<string, SystemOneQuestion> = {
  evidence: { type: 'choice', instructions: 'What backs it?', criteria: { primary: 'Data', opinion: 'None' } },
  relevance: { type: 'score', instructions: 'How relevant?', criteria: ['unrelated', 'relevant', 'core'] },
  personal: { type: 'bool', instructions: 'Personal data?', criteria: { true: 'Yes', false: 'No' } },
};

const answers = {
  evidence: { type: 'choice', choice: 'primary', probabilities: { primary: 0.8, opinion: 0.2 }, confidence: 0.9 },
  relevance: { type: 'score', score: 1.6, confidence: 0.7 },
  personal: { type: 'noul', noul: 0.05 },
};

test('one request asks every question, with bool as noul on the wire, and each answer is read by its type', async () => {
  await withStubServer(() => ({ body: { answers, usage: { input_tokens: 120, output_tokens: 3 } } }), async (url, requests) => {
    const asked = await askSystemOne(client, judge(url), { state, questions });
    assert.deepEqual(asked, {
      ok: true,
      value: {
        answers: {
          evidence: { type: 'choice', choice: 'primary', probabilities: { primary: 0.8, opinion: 0.2 }, confidence: 0.9 },
          relevance: { type: 'score', score: 1.6, confidence: 0.7 },
          personal: { type: 'bool', probability: 0.05 },
        },
        usage: { inputTokens: 120, outputTokens: 3 },
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, '/v1/systemone');
    assert.equal(requests[0]?.headers['authorization'], `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), {
      model: 'laya',
      state,
      questions: { ...questions, personal: { ...questions['personal'], type: 'noul' } },
    });
  });
});

test('usage may be absent', async () => {
  await withStubServer(() => ({ body: { answers } }), async (url) => {
    const asked = await askSystemOne(client, judge(url), { state, questions });
    assert.ok(asked.ok && asked.value.usage === undefined);
  });
});

test('a missing answer, a wrong type or an answer outside its question fails the request, never yields a partial result', async () => {
  const cases: Record<string, unknown>[] = [
    { evidence: answers.evidence, relevance: answers.relevance },
    { ...answers, personal: { type: 'bool', noul: 0.05 } },
    { ...answers, relevance: { type: 'choice', choice: 'core', probabilities: {}, confidence: 1 } },
    { ...answers, evidence: { ...answers.evidence, choice: 'hearsay' } },
    { ...answers, evidence: { ...answers.evidence, probabilities: { primary: 0.9, opinion: 0.9 } } },
    { ...answers, evidence: { ...answers.evidence, probabilities: { primary: 'high' } } },
    { ...answers, relevance: { ...answers.relevance, score: 2.5 } },
    { ...answers, relevance: { ...answers.relevance, confidence: 1.2 } },
    { ...answers, personal: { type: 'noul', noul: -0.1 } },
  ];
  for (const given of cases) {
    await withStubServer(() => ({ body: { answers: given } }), async (url) => {
      const asked = await askSystemOne(client, judge(url), { state, questions });
      assert.equal(!asked.ok && asked.error.reason, 'bad-response', JSON.stringify(given));
      assert.equal(!asked.ok && asked.error.role, 'judgement');
    });
  }
  await withStubServer(() => ({ body: { result: 'yes' } }), async (url) => {
    const asked = await askSystemOne(client, judge(url), { state, questions });
    assert.equal(!asked.ok && asked.error.reason, 'bad-response');
  });
});

test('content too large for the model, a redirect and other failures are errors naming the role, never the token', async () => {
  for (const [status, reason] of [[413, 'http-error'], [400, 'http-error'], [500, 'http-error'], [308, 'redirected']] as const) {
    await withStubServer(() => ({ status, headers: { location: 'http://127.0.0.1:1/' }, body: `echo ${TOKEN}` }), async (url) => {
      const asked = await askSystemOne(client, judge(url), { state, questions });
      assert.deepEqual(asked, { ok: false, error: { reason, role: 'judgement', status } });
      assert.ok(!JSON.stringify(asked).includes(TOKEN));
    });
  }
});
