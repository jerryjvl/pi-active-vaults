// Documented behaviour: concepts.md "Judgement axes" and "Script" (judgements
// are checks that call a judgement model), core.md "Judgements" — a commit
// judges the documents its proposal's merge rules still need judged, after
// the blocking checks pass; a judgement that cannot be made never fails the
// commit, it only leaves the requirement unmet; review judges whatever is
// still missing for the current content; accept only evaluates what is
// recorded and never asks a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AGENT_MODEL } from '../../support/models.ts';
import { withInstallation, writeFiles, type TestInstallation } from '../../support/installation.ts';
import { withStubServer, type RecordedRequest, type StubResponse } from '../../support/stub-server.ts';
import { withForgeInstallation } from '../../support/forge-vault.ts';
import { FORGE_TOKEN } from '../../support/forge-stub.ts';

const AXES = [
  'axes:',
  '  evidence:',
  '    type: choice',
  '    instructions: What backs it?',
  '    options: { primary: Data, opinion: None }',
  '    pass-when: { choices: [primary], probability: 0.7 }',
  'merge:',
  '  - { paths: ["topics/**"], require: [judgement:evidence] }',
].join('\n');

/** Whether the stub model answers, and how. */
const judge = { up: true, primary: 0.9 };

function answer(): StubResponse {
  if (!judge.up) return { status: 503, body: { error: 'down' } };
  return { body: { answers: { evidence: { type: 'choice', choice: judge.primary >= 0.5 ? 'primary' : 'opinion', probabilities: { primary: judge.primary, opinion: 1 - judge.primary }, confidence: 0.9 } } } };
}

/** An installation whose default judgement model is the stub, allowed for the vault. */
function withJudgedInstallation(run: (t: TestInstallation, requests: RecordedRequest[]) => Promise<void>): () => Promise<void> {
  return () => withStubServer(answer, (url, requests) => withInstallation((t) => run(t, requests), {
    noDefaultModels: true,
    env: { JUDGE_TOKEN: 'token' },
    contract: { extra: AXES },
    config: [
      'models:',
      `  judgement: { url: "${url}/v1", token: "\${JUDGE_TOKEN}", model: d3 }`,
      `  agent: { model: ${AGENT_MODEL} }`,
      'policy:',
      '  - { vaults: [home], allow-models: [agent, judgement] }',
    ].join('\n'),
  })());
}

async function commitAs(t: TestInstallation, files: Record<string, string>, message = 'Work'): Promise<Awaited<ReturnType<TestInstallation['run']>>> {
  await t.run('write', { path: '.keep-worktree.md', content: 'x', actor: 'gardener' }, { surface: 'mcp' });
  writeFiles(join(t.vault.worktrees, 'gardener'), files);
  return t.run('commit', { message, actor: 'gardener' });
}

const judgementRequests = (requests: RecordedRequest[]): number => requests.filter((r) => r.url === '/v1/systemone').length;

test('a commit judges what its proposal\'s merge rules need, so the requirement is met by the time of review', withJudgedInstallation(async (t, requests) => {
  judge.up = true; judge.primary = 0.9;
  const committed = await commitAs(t, { 'topics/a.md': 'Measured data.' });
  assert.equal(committed.status, 'ok', committed.text);
  assert.match(committed.text, /judged topics\/a\.md: evidence pass/);
  assert.equal(judgementRequests(requests), 1);

  const status = await t.run('status');
  assert.match(status.text, /met judgement:evidence/);
  assert.match(status.text, /merge policy satisfied|merge policy met once an owner accepts it/);
}));

test('a commit that cannot be judged still lands; the requirement stays unmet and says why', withJudgedInstallation(async (t) => {
  judge.up = false;
  const committed = await commitAs(t, { 'topics/a.md': 'Measured data.' });
  assert.equal(committed.status, 'ok', committed.text);
  assert.match(committed.text, /topics\/a\.md could not be judged/);
  const status = await t.run('status');
  assert.match(status.text, /unmet judgement:evidence/);
}));

test('review judges what is still missing for the current content', withJudgedInstallation(async (t, requests) => {
  judge.up = false;
  assert.equal((await commitAs(t, { 'topics/a.md': 'Measured data.' })).status, 'ok');
  judge.up = true; judge.primary = 0.9;
  const before = judgementRequests(requests);
  const reviewed = await t.run('review', { actor: 'gardener' });
  assert.equal(reviewed.status, 'ok', reviewed.text);
  assert.equal(judgementRequests(requests), before + 1);
  assert.match(reviewed.text, /met judgement:evidence/);

  // Already judged for this content: a second review asks nothing.
  await t.run('review', { actor: 'gardener' });
  assert.equal(judgementRequests(requests), before + 1);
}));

test('a failing judgement is recorded as a failure, never a pass', withJudgedInstallation(async (t) => {
  judge.up = true; judge.primary = 0.2;
  const committed = await commitAs(t, { 'topics/a.md': 'Just an opinion.' });
  assert.equal(committed.status, 'ok', committed.text);
  assert.match(committed.text, /judged topics\/a\.md: evidence fail/);
  assert.match((await t.run('status')).text, /unmet judgement:evidence/);
}));

test('accept evaluates what is recorded and never asks a model', withJudgedInstallation(async (t, requests) => {
  judge.up = true; judge.primary = 0.9;
  assert.equal((await commitAs(t, { 'topics/a.md': 'Measured data.' })).status, 'ok');
  assert.equal((await t.run('review', { actor: 'gardener' })).status, 'ok');
  const before = judgementRequests(requests);
  const accepted = await t.run('accept', { actor: 'gardener' });
  assert.equal(accepted.status, 'ok', accepted.text);
  assert.equal(judgementRequests(requests), before);
}));

test('a commit whose rules need no judgement asks no model', withJudgedInstallation(async (t, requests) => {
  judge.up = true;
  const committed = await commitAs(t, { 'notes/a.md': 'Not under topics.' });
  assert.equal(committed.status, 'ok', committed.text);
  assert.equal(judgementRequests(requests), 0);
  assert.doesNotMatch(committed.text, /judged/);
}));

test('propose judges what the proposal needs before publishing, so vault/policy counts it', () => withStubServer(answer, (url, requests) => withForgeInstallation(async (t) => {
  judge.up = true; judge.primary = 0.9;
  assert.equal((await t.run('write', { path: 'topics/a.md', content: 'Measured data.', actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
  judge.up = false;
  assert.equal((await t.run('commit', { message: 'A topic', actor: 'gardener' })).status, 'ok');
  judge.up = true;
  const before = judgementRequests(requests);
  const proposed = await t.run('propose', { actor: 'gardener' });
  assert.equal(proposed.status, 'ok', proposed.text);
  assert.match(proposed.text, /judged topics\/a\.md: evidence pass\nOpened pull request #1 .*; vault\/policy: success\./);
  assert.equal(judgementRequests(requests), before + 1);
}, {
  noDefaultModels: true,
  env: { FORGE_TOKEN, JUDGE_TOKEN: 'token' },
  contract: { review: 'forge', extra: AXES },
  config: [
    'models:',
    `  judgement: { url: "${url}/v1", token: "\${JUDGE_TOKEN}", model: d3 }`,
    `  agent: { model: ${AGENT_MODEL} }`,
    'policy:',
    '  - { vaults: [home], allow-models: [agent, judgement] }',
  ].join('\n'),
})()));
