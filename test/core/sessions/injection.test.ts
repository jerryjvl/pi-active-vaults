// Documented behaviour: extension.md "Context injection" and concepts.md
// "Contracts", "applies-when" — when a session first reads or edits a path,
// the effective contract's prose for it and any matching `inject` documents
// are added; `session.start` and `session.tool` documents likewise; each
// document at most once per session; everything from the accepted `main`
// only (security.md), in a stable order (principle 16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectionsFor, renderInjections, type VaultSession } from '../../../src/core/sessions/index.ts';
import { AGENT_MODEL } from '../../support/models.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { RUNNING, openTestSession } from '../../support/session.ts';
import { rootContract } from '../../support/vault.ts';

const inject = (on: string, extra = '') => `---\napplies-when:\n  - { on: ${on}, effect: inject${extra} }\n---\n`;

async function opened(t: TestInstallation): Promise<VaultSession> {
  return openTestSession(t, { actor: 'gardener' });
}

const keys = (found: readonly { vault: string; path: string }[]) => found.map((i) => `${i.vault}:${i.path}`);

test('a path\'s contracts are injected the first time it is touched, root first; never twice', withInstallation(async (t) => {
  t.repo.write('notes/_contract.md', '---\nindex: default\n---\nNotes are short.\n');
  t.repo.commit('notes contract');
  t.accept();
  const s = await opened(t);
  const first = await injectionsFor(t.context, s, { kind: 'session.path', vault: 'home', path: 'notes/deep/a.md' });
  assert.deepEqual(keys(first), ['home:_contract.md', 'home:notes/_contract.md']);
  assert.match(renderInjections(first), /home:_contract\.md[^]*Root prose\.[^]*home:notes\/_contract\.md[^]*Notes are short\./);
  assert.deepEqual(await injectionsFor(t.context, s, { kind: 'session.path', vault: 'home', path: 'notes/b.md' }), []);
}, { running: RUNNING }));

test('documents whose inject conditions match a session event are injected once: paths, start and tools', withInstallation(async (t) => {
  t.repo.write('memory/infra.md', `${inject('session.path', ', paths: ["projects/**"]')}Use the staging network.\n`);
  t.repo.write('memory/always.md', `${inject('session.start')}Be brief.\n`);
  t.repo.write('memory/shell.md', `${inject('session.tool', ', tools: [bash]')}Prefer scripts.\n`);
  t.repo.write('memory/job.md', '---\napplies-when: [{ on: session.start, effect: spawn }]\nbudget: { tokens: 10, ttl: 1m }\n---\nA job, not memory.\n');
  t.repo.commit('memories');
  t.accept();
  const s = await opened(t);
  assert.deepEqual(keys(await injectionsFor(t.context, s, { kind: 'session.start' })), ['home:memory/always.md']);
  assert.deepEqual(keys(await injectionsFor(t.context, s, { kind: 'session.tool', tool: 'read' })), []);
  const shell = await injectionsFor(t.context, s, { kind: 'session.tool', tool: 'bash' });
  assert.deepEqual(keys(shell), ['home:memory/shell.md']);
  assert.match(renderInjections(shell), /Prefer scripts\./);
  assert.doesNotMatch(renderInjections(shell), /applies-when/, 'the body, without the frontmatter');
  const path = await injectionsFor(t.context, s, { kind: 'session.path', vault: 'home', path: 'projects/net.md' });
  assert.deepEqual(keys(path), ['home:_contract.md', 'home:memory/infra.md']);
  assert.deepEqual(await injectionsFor(t.context, s, { kind: 'session.path', vault: 'home', path: 'projects/other.md' }), []);
}, { running: RUNNING }));

test('a model filter names a configured model and injects only for a session running on it', withInstallation(async (t) => {
  t.repo.write('memory/big.md', `${inject('session.start', ', model: agent')}Think hard.\n`);
  t.repo.write('memory/ghost.md', `${inject('session.start', ', model: telepathy')}Never.\n`);
  t.repo.commit('memory');
  t.accept();
  const s = await opened(t);
  assert.deepEqual(await injectionsFor(t.context, s, { kind: 'session.start', model: 'other/small-model' }), []);
  assert.deepEqual(keys(await injectionsFor(t.context, s, { kind: 'session.start', model: AGENT_MODEL })), ['home:memory/big.md']);
}, { running: RUNNING }));

test('only the accepted main\'s contracts and documents are injected', withInstallation(async (t) => {
  t.repo.write('memory/always.md', `${inject('session.start')}Accepted memory.\n`);
  t.repo.commit('memory');
  t.accept();
  t.repo.write('memory/always.md', `${inject('session.start')}Unaccepted memory.\n`);
  t.repo.write('memory/new.md', `${inject('session.start')}Unaccepted document.\n`);
  t.repo.write('_contract.md', rootContract().replace('Root prose.', 'Unaccepted prose.'));
  t.repo.commit('unaccepted changes');
  const s = await opened(t);
  const start = await injectionsFor(t.context, s, { kind: 'session.start' });
  assert.deepEqual(keys(start), ['home:memory/always.md']);
  assert.match(renderInjections(start), /Accepted memory\./);
  const path = renderInjections(await injectionsFor(t.context, s, { kind: 'session.path', vault: 'home', path: 'a.md' }));
  assert.match(path, /Root prose\./);
  assert.doesNotMatch(path, /Unaccepted/);
}, { running: RUNNING }));
