// Documented behaviour: core.md "Judgements", concepts.md "Judgement axes" and
// "Merge policy" — a judgement sends a document's content as state, with the
// questions of the axes in effect for its path on the accepted `main`, to the
// judgement model; applies each axis's `pass-when`; and records the outcome as
// attestations about the content, with the content hash, model and axes
// version. An axis may name the judgement model that answers it: axes are
// grouped by the model that answers them, one request each; a name that is not
// configured is answered by the default, a name with the wrong role or a
// configured model the policy does not allow is never replaced by it, and a
// missing default leaves the axes that need it unjudged without failing the
// rest. A judgement that cannot be made — no permitted model, an error,
// content too large — is a failure, never a pass, and records nothing. Like
// every check it is refused while `main` has an unaccepted change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttestations } from '../../../src/core/attestations/index.ts';
import type { InstallationConfig, ModelEntry } from '../../../src/core/config/index.ts';
import { requireNoUnacceptedChange } from '../../../src/core/integrity/index.ts';
import { judgeDocument, judgeProposal, type JudgementDeps } from '../../../src/core/judgements/index.ts';
import { axesVersion, evaluateMerge } from '../../../src/core/policy/index.ts';
import { TEST_ATTRIBUTION } from '../../support/git-repo.ts';
import { startStubServer, type RecordedRequest, type StubServer } from '../../support/stub-server.ts';
import { rootContract, withTestVault, type TestVault } from '../../support/vault.ts';

const EVIDENCE = { type: 'choice', instructions: 'What backs it?', options: { primary: 'Data', opinion: 'None' }, 'pass-when': { choices: ['primary'], probability: 0.7 } };
const PERSONAL = { type: 'bool', instructions: 'Personal data?', true: 'Contains such data', false: 'Contains none', 'pass-when': { value: false, probability: 0.9 } };

const axesYaml = (evidenceThreshold = 0.7): string => [
  'axes:',
  '  evidence:',
  '    type: choice',
  '    instructions: What backs it?',
  '    options: { primary: Data, opinion: None }',
  `    pass-when: { choices: [primary], probability: ${evidenceThreshold} }`,
  '  personal:',
  '    type: bool',
  '    instructions: Personal data?',
  '    true: Contains such data',
  '    false: Contains none',
  '    pass-when: { value: false, probability: 0.9 }',
  'merge:',
  '  - { paths: ["topics/**"], require: [judgement:evidence, judgement:personal] }',
].join('\n');

/** The model's answer: p(primary) and p(personal data). */
let answer = { primary: 0.8, personal: 0.02 };

async function withJudge(run: (judge: StubServer) => Promise<void>, respond?: () => { status: number }): Promise<void> {
  const judge = await startStubServer((request) => {
    if (respond !== undefined) return respond();
    assert.equal(request.url, '/v1/systemone');
    return {
      body: {
        answers: {
          evidence: { type: 'choice', choice: answer.primary >= 0.5 ? 'primary' : 'opinion', probabilities: { primary: answer.primary, opinion: 1 - answer.primary }, confidence: 0.9 },
          personal: { type: 'noul', noul: answer.personal },
        },
        usage: { input_tokens: 50, output_tokens: 2 },
      },
    };
  });
  try {
    await run(judge);
  } finally {
    await judge.close();
  }
}

const endpointAt = (url: string, model: string, role: 'judgement' | 'embed' = 'judgement'): ModelEntry =>
  ({ role, url: `${url}/v1`, token: { kind: 'env', name: 'T', where: 'models.judgement.token' }, model, batch: 1, parallel: 2 });

function deps(v: TestVault, url: string, overrides: { model?: string; policy?: InstallationConfig['policy']; models?: InstallationConfig['models'] } = {}): JudgementDeps {
  return {
    git: v.git,
    store: v.store,
    config: { models: overrides.models ?? { judgement: endpointAt(url, overrides.model ?? 'laya') }, policy: overrides.policy ?? [{ vaults: ['home'], allowModels: ['judgement'] }] },
    client: { fetch, secrets: { env: { T: 'token' }, runCommand: async () => assert.fail('no command') }, timeoutMs: 5000 },
    clock: v.clock,
    attribution: TEST_ATTRIBUTION,
  };
}

const TOPIC = '---\nlabels: [cars]\n---\n# A topic\n\nTyres last 40,000 km, per the maker\'s data.\n';

const asked = (request: RecordedRequest | undefined): { model: string; state: Record<string, unknown>; questions: Record<string, { type: string }> } =>
  JSON.parse(request?.body ?? '{}');

test('a document is judged on every axis in effect for it, in one request, and each axis is recorded as an attestation about its content', withTestVault(async (v) => {
  answer = { primary: 0.8, personal: 0.02 };
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withJudge(async (judge) => {
    const judged = await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok, JSON.stringify(judged));
    const blob = v.repo.git('rev-parse', `${head}:topics/a.md`);
    assert.equal(judged.value.subject, blob);
    assert.equal(judged.value.passed, true);
    assert.deepEqual(judged.value.axes.map((a) => [a.name, a.result, a.reused]), [['evidence', 'pass', false], ['personal', 'pass', false]]);
    assert.deepEqual(judged.value.usage, { inputTokens: 50, outputTokens: 2 });

    assert.equal(judge.requests.length, 1);
    const body = asked(judge.requests[0]);
    assert.equal(body.model, 'laya');
    assert.deepEqual(body.state, { vault: 'Home things.', path: 'topics/a.md', title: 'A topic', labels: ['cars'], content: TOPIC });
    assert.deepEqual(Object.entries(body.questions).map(([name, q]) => [name, q.type]), [['evidence', 'choice'], ['personal', 'noul']]);

    const records = await readAttestations(v.git, v.repo.path, blob);
    assert.ok(records.ok);
    assert.deepEqual(records.value.map((r) => [r.kind, r.name, r.subject, r.result, r.by, r.version]), [
      ['judgement', 'evidence', blob, 'pass', 'laya', axesVersion(EVIDENCE)],
      ['judgement', 'personal', blob, 'pass', 'laya', axesVersion(PERSONAL)],
    ]);

    // The merge policy now finds both judgements for the proposal's content.
    const accepted = await requireNoUnacceptedChange(v.git, v.store, v.vault);
    assert.ok(accepted.ok);
    const evaluation = await evaluateMerge(v.git, v.repo.path, { accepted: accepted.value, base: v.initial, head, tainted: false });
    assert.ok(evaluation.ok);
    assert.deepEqual(evaluation.value.verdict.requirements.filter((r) => r.requirement.startsWith('judgement:')).map((r) => [r.requirement, r.met]), [
      ['judgement:evidence', true], ['judgement:personal', true],
    ]);
  });
}, { extra: axesYaml() }));

test('a judgement passes only when every axis passes', withTestVault(async (v) => {
  answer = { primary: 0.8, personal: 0.5 };
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withJudge(async (judge) => {
    const judged = await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok);
    assert.equal(judged.value.passed, false);
    assert.deepEqual(judged.value.axes.map((a) => [a.name, a.result]), [['evidence', 'pass'], ['personal', 'fail']]);
  });
}, { extra: axesYaml() }));

test('the axes come from the accepted main, never from the proposal being judged', withTestVault(async (v) => {
  answer = { primary: 0.5, personal: 0.02 };
  v.accept();
  const head = v.propose({ '_contract.md': rootContract({ extra: axesYaml(0.1) }), 'topics/a.md': TOPIC });
  await withJudge(async (judge) => {
    const judged = await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok);
    assert.equal(judged.value.axes.find((a) => a.name === 'evidence')?.result, 'fail', 'judged against 0.7, not the proposal\'s 0.1');
  });
}, { extra: axesYaml() }));

test('content judged before, by the same model under the same axes, is not sent again; another model asks again', withTestVault(async (v) => {
  answer = { primary: 0.8, personal: 0.02 };
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withJudge(async (judge) => {
    assert.ok((await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' })).ok);
    const again = await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(again.ok);
    assert.deepEqual(again.value.axes.map((a) => a.reused), [true, true]);
    assert.equal(again.value.usage, undefined);
    assert.equal(judge.requests.length, 1);
    assert.ok((await judgeDocument(deps(v, judge.url, { model: 'other' }), { vault: v.vault, commit: head, path: 'topics/a.md' })).ok);
    assert.equal(judge.requests.length, 2);
  });
}, { extra: axesYaml() }));

test('a judgement that cannot be made fails and records nothing: no permitted model, a failing or overwhelmed model, no such document', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  const blob = v.repo.git('rev-parse', `${head}:topics/a.md`);
  const request = { vault: v.vault, commit: head, path: 'topics/a.md' };
  await withJudge(async (judge) => {
    const refused = await judgeDocument(deps(v, judge.url, { policy: [] }), request);
    assert.ok(refused.ok);
    assert.equal(refused.value.passed, false, 'an unjudged axis never passes');
    assert.deepEqual(refused.value.axes, []);
    assert.deepEqual(refused.value.unjudged.map((u) => [u.name, u.reason]), [
      ['evidence', { reason: 'not-allowed', role: 'judgement', name: 'judgement', vault: 'home' }],
      ['personal', { reason: 'not-allowed', role: 'judgement', name: 'judgement', vault: 'home' }],
    ]);
    assert.equal(judge.requests.length, 0, 'no content sent where the policy does not allow it');
    const missing = await judgeDocument(deps(v, judge.url), { ...request, path: 'topics/none.md' });
    assert.equal(!missing.ok && missing.error.reason, 'not-found');
  });
  for (const status of [413, 500]) {
    await withJudge(async (judge) => {
      const failed = await judgeDocument(deps(v, judge.url), request);
      assert.deepEqual(!failed.ok && failed.error, { reason: 'http-error', role: 'judgement', status });
    }, () => ({ status }));
  }
  assert.deepEqual(await readAttestations(v.git, v.repo.path, blob), { ok: true, value: [] });
}, { extra: axesYaml() }));

test('a document with no axes in effect cannot be judged', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withJudge(async (judge) => {
    const noAxes = await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.deepEqual(!noAxes.ok && noAxes.error, { reason: 'no-axes', path: 'topics/a.md' });
    assert.equal(judge.requests.length, 0);
  });
}));

test('judging is refused while main has an unaccepted change, and nothing is sent', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  v.repo.write('stray.md', 'x');
  v.repo.commit('stray commit on main');
  await withJudge(async (judge) => {
    const refused = await judgeDocument(deps(v, judge.url), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.equal(!refused.ok && refused.error.reason, 'unaccepted-change');
    assert.equal(judge.requests.length, 0);
  });
}, { extra: axesYaml() }));

test('judging a proposal judges exactly the documents its merge policy needs judged', withTestVault(async (v) => {
  answer = { primary: 0.8, personal: 0.02 };
  v.repo.write('topics/old.md', TOPIC);
  v.repo.commit('old topic');
  v.accept();
  v.repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  v.repo.git('rm', '--quiet', 'topics/old.md');
  v.repo.write('topics/a.md', TOPIC);
  v.repo.write('topics/b.md', TOPIC.replace('A topic', 'B topic'));
  v.repo.write('notes/n.md', 'Not under a judgement rule.\n');
  v.repo.commit('proposal\n\nVault-Trace: 01TRACE\nVault-Actor: gardener');
  v.repo.git('checkout', '--quiet', 'main');
  await withJudge(async (judge) => {
    const judged = await judgeProposal(deps(v, judge.url), { vault: v.vault, actor: 'gardener' });
    assert.ok(judged.ok, JSON.stringify(judged));
    assert.deepEqual(judged.value.map((j) => [j.path, j.outcome.ok && j.outcome.value.passed]), [['topics/a.md', true], ['topics/b.md', true]]);
    assert.equal(judge.requests.length, 2, 'the deleted document needs an owner, not a judgement');
  });
}, { extra: axesYaml() }));

// concepts.md "Judgement axes" and "Models": an axis may name the model that answers it.
const withModelAxes = (model: string | undefined, other?: string): string => axesYaml()
  .replace('  personal:\n', `  personal:\n${model === undefined ? '' : `    model: ${model}\n`}`)
  .replace('  evidence:\n', `  evidence:\n${other === undefined ? '' : `    model: ${other}\n`}`);

/** A judgement model that answers whatever it is asked, passing everything. */
const passing = (name: string) => startStubServer((request) => {
  const { questions } = JSON.parse(request.body) as { questions: Record<string, unknown> };
  return {
    body: {
      answers: Object.fromEntries(Object.keys(questions).map((q) => [q, q === 'evidence'
        ? { type: 'choice', choice: 'primary', probabilities: { primary: 0.9, opinion: 0.1 }, confidence: 0.9 }
        : { type: 'noul', noul: 0.01 }])),
      usage: { input_tokens: 10, output_tokens: 1, via: name },
    },
  };
});

async function withServers(run: (servers: { strong: StubServer; fast: StubServer }) => Promise<void>): Promise<void> {
  const [strong, fast] = [await passing('strong'), await passing('fast')];
  try {
    await run({ strong, fast });
  } finally {
    await strong.close();
    await fast.close();
  }
}

const twoModels = (s: { strong: StubServer; fast: StubServer }): InstallationConfig['models'] =>
  ({ judgement: endpointAt(s.strong.url, 'strong'), classify: endpointAt(s.fast.url, 'fast') });
const allowAll: InstallationConfig['policy'] = [{ vaults: ['home'], allowModels: ['judgement', 'classify'] }];

test('axes are grouped by the model that answers them, one request each, and each attestation names the model actually used', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withServers(async (s) => {
    const judged = await judgeDocument(deps(v, s.strong.url, { models: twoModels(s), policy: allowAll }), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok, JSON.stringify(judged));
    assert.equal(judged.value.passed, true);
    assert.deepEqual(judged.value.axes.map((a) => [a.name, a.model]), [['evidence', 'strong'], ['personal', 'fast']]);
    assert.deepEqual(judged.value.unjudged, []);
    assert.deepEqual(Object.keys(asked(s.strong.requests[0]).questions), ['evidence']);
    assert.deepEqual(Object.keys(asked(s.fast.requests[0]).questions), ['personal']);
    assert.equal(asked(s.fast.requests[0]).model, 'fast');
    assert.deepEqual([s.strong.requests.length, s.fast.requests.length], [1, 1]);
    assert.deepEqual(judged.value.usage, { inputTokens: 20, outputTokens: 2 }, 'the requests\' usage adds up');

    const blob = v.repo.git('rev-parse', `${head}:topics/a.md`);
    const records = await readAttestations(v.git, v.repo.path, blob);
    assert.ok(records.ok);
    assert.deepEqual(records.value.map((r) => [r.name, r.by]), [['evidence', 'strong'], ['personal', 'fast']]);
  });
}, { extra: withModelAxes('classify') }));

test('axes sharing a model share a request, and the model an axis names is part of its version', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  const blob = v.repo.git('rev-parse', `${head}:topics/a.md`);
  await withServers(async (s) => {
    const config = { models: twoModels(s), policy: allowAll };
    const judged = await judgeDocument(deps(v, s.strong.url, config), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok);
    assert.deepEqual([s.strong.requests.length, s.fast.requests.length], [0, 1]);
    assert.deepEqual(Object.keys(asked(s.fast.requests[0]).questions), ['evidence', 'personal']);
    const records = await readAttestations(v.git, v.repo.path, blob);
    assert.ok(records.ok);
    const withModel = { ...PERSONAL, model: 'classify' };
    assert.notEqual(axesVersion(withModel), axesVersion(PERSONAL));
    assert.equal(records.value.find((r) => r.name === 'personal')?.version, axesVersion(withModel));
    assert.equal(records.value.find((r) => r.name === 'evidence')?.version, axesVersion({ ...EVIDENCE, model: 'classify' }));
  });
}, { extra: withModelAxes('classify', 'classify') }));

test('a judgement made under one model is not taken for another: the model the axis names changes its version', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withServers(async (s) => {
    const config = { models: twoModels(s), policy: allowAll };
    const first = await judgeDocument(deps(v, s.strong.url, config), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(first.ok);
    // The same content, judged again under the same axes and models, is reused; nothing is sent.
    const again = await judgeDocument(deps(v, s.strong.url, config), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(again.ok && again.value.axes.every((a) => a.reused));
    assert.deepEqual([s.strong.requests.length, s.fast.requests.length], [1, 1]);
  });
}, { extra: withModelAxes('classify') }));

test('a name that is not configured is answered by the default, and the judgement says so', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withServers(async (s) => {
    const models = { judgement: endpointAt(s.strong.url, 'strong') };
    const judged = await judgeDocument(deps(v, s.strong.url, { models, policy: allowAll }), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok, JSON.stringify(judged));
    assert.deepEqual(judged.value.axes.map((a) => [a.name, a.model, a.substitutedFor]), [['evidence', 'strong', undefined], ['personal', 'strong', 'classify']]);
    assert.equal(s.fast.requests.length, 0);
    assert.equal(s.strong.requests.length, 1);
  });
}, { extra: withModelAxes('classify') }));

test('a configured model the policy does not allow is never replaced by the default: its axis stays unjudged and nothing is sent for it', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  const blob = v.repo.git('rev-parse', `${head}:topics/a.md`);
  await withServers(async (s) => {
    const policy = [{ vaults: ['home'], allowModels: ['judgement'] }];
    const judged = await judgeDocument(deps(v, s.strong.url, { models: twoModels(s), policy }), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok, JSON.stringify(judged));
    assert.equal(judged.value.passed, false);
    assert.deepEqual(judged.value.axes.map((a) => a.name), ['evidence']);
    assert.deepEqual(judged.value.unjudged, [{ name: 'personal', reason: { reason: 'not-allowed', role: 'judgement', name: 'classify', vault: 'home' } }]);
    assert.equal(s.fast.requests.length, 0, 'the disallowed model received nothing');
    assert.deepEqual(Object.keys(asked(s.strong.requests[0]).questions), ['evidence'], 'and the default did not take its question');
    const records = await readAttestations(v.git, v.repo.path, blob);
    assert.ok(records.ok);
    assert.deepEqual(records.value.map((r) => r.name), ['evidence'], 'the unjudged axis recorded nothing');
  });
}, { extra: withModelAxes('classify') }));

test('a missing default leaves the axes that need it unjudged; axes naming a configured model are still judged', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withServers(async (s) => {
    const models = { classify: endpointAt(s.fast.url, 'fast') };
    const judged = await judgeDocument(deps(v, s.strong.url, { models, policy: allowAll }), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok, JSON.stringify(judged));
    assert.equal(judged.value.passed, false);
    assert.deepEqual(judged.value.axes.map((a) => [a.name, a.model]), [['personal', 'fast']]);
    assert.deepEqual(judged.value.unjudged, [{ name: 'evidence', reason: { reason: 'no-default', role: 'judgement' } }]);
    assert.equal(s.strong.requests.length, 0);
  });
}, { extra: withModelAxes('classify', undefined) }));

test('an axis naming a model of another role is not judged, and the default does not answer it', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withServers(async (s) => {
    const models: InstallationConfig['models'] = { judgement: endpointAt(s.strong.url, 'strong'), quick: { role: 'agent', model: 'homeserver/small' } };
    const judged = await judgeDocument(deps(v, s.strong.url, { models, policy: [{ vaults: ['home'], allowModels: ['judgement', 'quick'] }] }), { vault: v.vault, commit: head, path: 'topics/a.md' });
    assert.ok(judged.ok, JSON.stringify(judged));
    assert.deepEqual(judged.value.unjudged, [{ name: 'personal', reason: { reason: 'wrong-role', role: 'judgement', name: 'quick', actual: 'agent' } }]);
    assert.deepEqual(Object.keys(asked(s.strong.requests[0]).questions), ['evidence']);
  });
}, { extra: withModelAxes('quick') }));

test('a requirement stays unmet for an unjudged axis: the merge policy finds no judgement for it', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'topics/a.md': TOPIC });
  await withServers(async (s) => {
    const policy = [{ vaults: ['home'], allowModels: ['judgement'] }];
    assert.ok((await judgeDocument(deps(v, s.strong.url, { models: twoModels(s), policy }), { vault: v.vault, commit: head, path: 'topics/a.md' })).ok);
    const accepted = await requireNoUnacceptedChange(v.git, v.store, v.vault);
    assert.ok(accepted.ok);
    const evaluation = await evaluateMerge(v.git, v.repo.path, { accepted: accepted.value, base: v.initial, head, tainted: false });
    assert.ok(evaluation.ok);
    assert.deepEqual(evaluation.value.verdict.requirements.filter((r) => r.requirement.startsWith('judgement:')).map((r) => [r.requirement, r.met]), [
      ['judgement:evidence', true], ['judgement:personal', false],
    ]);
  });
}, { extra: withModelAxes('classify') }));
