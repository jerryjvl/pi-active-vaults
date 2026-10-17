// Documented behaviour: concepts.md "Templates", cli.md `vault init
// --template` and `vault template show` — a template is a vault repository
// whose root contract carries a `template` marker (name, version, summary).
// Creating a vault from one copies its current content into a new repository
// with fresh history, sets the new vault's id, and replaces the marker with
// `vault.from-template` — the source URL and commit. The first commit is the
// new vault's accepted main. Short names come from the installation config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from '../../../src/core/documents/index.ts';
import { integrityStatus } from '../../../src/core/integrity/index.ts';
import { openStateStore } from '../../../src/core/operations/index.ts';
import { createEmptyVault, createFromTemplate, inspectTemplate, resolveTemplateSpec } from '../../../src/core/templates/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { TEST_ATTRIBUTION, createTempRepo, gitFor, type TempRepo } from '../../support/git-repo.ts';
import { withTempDir, type TempDir } from '../../support/temp-dir.ts';

const MARKED = [
  '---',
  'template:',
  '  name: research-digests',
  '  version: 2',
  '  summary: Scheduled research on chosen topics.',
  'vault:',
  '  id: research-digests',
  '  purpose: { summary: Research digests. }',
  '  audience: me',
  '  owners: [alice]',
  '  actors: [researcher]',
  '# Rules everyone follows:',
  'merge:',
  '  - { paths: ["**"], require: [checks, owner] }',
  '---',
  'Prose of the template.',
  '',
].join('\n');

function templateRepo(contract = MARKED): TempRepo {
  const repo = createTempRepo();
  repo.write('_contract.md', '---\nvault: { id: draft }\n---\nOld history.\n');
  repo.commit('old history');
  repo.write('_contract.md', contract);
  repo.write('topics/_contract.md', '---\nindex: default\n---\nTopics.\n');
  repo.write('.vault/scripts/due-topics.sh', '#!/bin/sh\n# name: due-topics\n# summary: Due topics\necho none\n');
  chmodSync(join(repo.path, '.vault/scripts/due-topics.sh'), 0o755);
  repo.commit('template content');
  repo.git('tag', 'v2');
  return repo;
}

async function withTemplate(run: (template: TempRepo, dir: TempDir) => Promise<void>, contract?: string): Promise<void> {
  const template = templateRepo(contract);
  try {
    await withTempDir((dir) => run(template, dir))();
  } finally {
    template.cleanup();
  }
}

test('a short name or a URL, each with an optional @ref, names a template source', () => {
  const named = { 'research-digests': 'https://git.example.net/templates/research-digests.git' };
  assert.deepEqual(resolveTemplateSpec('research-digests', named), { ok: true, value: { url: named['research-digests'] } });
  assert.deepEqual(resolveTemplateSpec('research-digests@v2', named), { ok: true, value: { url: named['research-digests'], ref: 'v2' } });
  assert.deepEqual(resolveTemplateSpec('git@git.example.net:t/x.git', {}), { ok: true, value: { url: 'git@git.example.net:t/x.git' } });
  assert.deepEqual(resolveTemplateSpec('git@git.example.net:t/x.git@main', {}), { ok: true, value: { url: 'git@git.example.net:t/x.git', ref: 'main' } });
  assert.deepEqual(resolveTemplateSpec('https://alice@git.example.net/t/x.git@v1', {}), { ok: true, value: { url: 'https://alice@git.example.net/t/x.git', ref: 'v1' } });
  assert.deepEqual(resolveTemplateSpec('nameless', {}), { ok: false, error: { reason: 'unknown-template', name: 'nameless' } });
  assert.deepEqual(resolveTemplateSpec('research-digests@--force', named), { ok: false, error: { reason: 'invalid-argument', argument: 'ref' } });
  assert.deepEqual(resolveTemplateSpec('ext::sh -c x', {}), { ok: false, error: { reason: 'invalid-argument', argument: 'remote' } });
});

test('a marked repository is summarised as a template, at the ref asked for', () => withTemplate(async (template) => {
  const git = gitFor(template);
  const shown = await inspectTemplate(git, { url: template.path, ref: 'v2' });
  assert.ok(shown.ok, JSON.stringify(shown));
  assert.deepEqual(shown.value, {
    url: template.path,
    ref: 'v2',
    commit: template.git('rev-parse', 'v2^{commit}'),
    template: { name: 'research-digests', version: 2, summary: 'Scheduled research on chosen topics.' },
    vault: { purpose: 'Research digests.', owners: ['alice'], actors: ['researcher'] },
    files: 3,
  });
}));

test('a repository without the marker, or with a malformed one, is not a template', async () => {
  await withTemplate(async (template) => {
    const shown = await inspectTemplate(gitFor(template), { url: template.path });
    assert.equal(!shown.ok && shown.error.reason, 'not-a-template');
  }, '---\nvault: { id: plain, purpose: { summary: P }, audience: me, owners: [alice], actors: [] }\n---\n');
  await withTemplate(async (template) => {
    const shown = await inspectTemplate(gitFor(template), { url: template.path });
    assert.deepEqual(!shown.ok && shown.error, {
      reason: 'invalid-template',
      issues: [{ path: 'template.version', message: 'must be a positive whole number' }, { path: 'template.summary', message: 'must be a non-empty string' }],
    });
  }, MARKED.replace('  version: 2\n', '').replace('  summary: Scheduled research on chosen topics.\n', ''));
});

test('a vault created from a template has its content, fresh history, its own id and the recorded origin, accepted', () => withTemplate(async (template, dir) => {
  const git = gitFor(template);
  const store = openStateStore({ stateDb: dir.file('state.sqlite') });
  assert.ok(store.ok);
  try {
    const path = dir.file('vaults', 'my-research');
    const commit = template.git('rev-parse', 'v2^{commit}');
    const created = await createFromTemplate({ git, store: store.value, clock: fakeClock(), attribution: TEST_ATTRIBUTION }, {
      source: { url: template.path, ref: 'v2' }, path, id: 'my-research', by: 'alice',
    });
    assert.ok(created.ok, JSON.stringify(created));
    const run = (...args: string[]) => template.git('-C', path, ...args);

    assert.equal(run('rev-list', '--count', 'HEAD'), '1', 'fresh history: one commit');
    assert.equal(run('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(run('ls-files', '-s', '.vault/scripts/due-topics.sh').split(' ')[0], '100755', 'modes are kept');
    assert.equal(readFileSync(join(path, 'topics/_contract.md'), 'utf8'), '---\nindex: default\n---\nTopics.\n');

    const contract = readFileSync(join(path, '_contract.md'), 'utf8');
    const parsed = parseDocument(contract);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.frontmatter['template'], undefined);
    const vault = parsed.value.frontmatter['vault'] as Record<string, unknown>;
    assert.equal(vault['id'], 'my-research');
    assert.deepEqual(vault['from-template'], { url: template.path, commit });
    assert.deepEqual(vault['owners'], ['alice']);
    assert.match(contract, /# Rules everyone follows:\nmerge:\n {2}- \{ paths: \["\*\*"\], require: \[checks, owner\] \}\n---\nProse of the template\.\n$/, 'the rest is as the template wrote it');

    assert.equal(created.value.accepted.how, 'init');
    assert.equal(created.value.accepted.sha, run('rev-parse', 'HEAD'));
    const status = await integrityStatus(git, store.value, { id: 'my-research', path });
    assert.equal(status.ok && status.value.state, 'accepted');
  } finally {
    store.value.close();
  }
}));

test('creating refuses a directory that is not empty, an invalid id, a transport without integrity, and a template holding a link', () => withTemplate(async (template, dir) => {
  const git = gitFor(template);
  const store = openStateStore({ stateDb: dir.file('state.sqlite') });
  assert.ok(store.ok);
  try {
    const deps = { git, store: store.value, clock: fakeClock(), attribution: TEST_ATTRIBUTION };
    const occupied = dir.file('occupied');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'keep.txt'), 'mine');
    const notEmpty = await createFromTemplate(deps, { source: { url: template.path }, path: occupied, id: 'x', by: 'alice' });
    assert.deepEqual(!notEmpty.ok && notEmpty.error, { reason: 'not-empty', path: occupied });
    assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'mine');

    const badId = await createFromTemplate(deps, { source: { url: template.path }, path: dir.file('a'), id: '../escape', by: 'alice' });
    assert.deepEqual(!badId.ok && badId.error, { reason: 'invalid-argument', argument: 'id' });
    const insecure = await createFromTemplate(deps, { source: { url: 'http://git.example.net/t.git' }, path: dir.file('b'), id: 'b', by: 'alice' });
    assert.deepEqual(!insecure.ok && insecure.error, { reason: 'invalid-argument', argument: 'remote' });
    assert.equal(existsSync(dir.file('a')) || existsSync(dir.file('b')), false, 'nothing created');

    symlinkSync('/etc/passwd', join(template.path, 'topics', 'link.md'));
    template.commit('a link');
    const linked = await createFromTemplate(deps, { source: { url: template.path }, path: dir.file('c'), id: 'c', by: 'alice' });
    assert.deepEqual(!linked.ok && linked.error, { reason: 'unsupported-entry', path: 'topics/link.md' });
    assert.equal(existsSync(dir.file('c')), false);
  } finally {
    store.value.close();
  }
}));

test('an empty vault is a new repository with a root contract naming its id and its owner, accepted from its first commit', withTempDir(async (dir) => {
  const state = openStateStore({ stateDb: dir.file('state.sqlite') });
  assert.ok(state.ok);
  try {
    const git = gitFor(createTempRepo());
    const deps = { git, store: state.value, clock: fakeClock(), attribution: TEST_ATTRIBUTION };
    const path = dir.file('vaults', 'notes');
    const created = await createEmptyVault(deps, { path, id: 'notes', by: 'alice' });
    assert.ok(created.ok, JSON.stringify(created));
    const contract = parseDocument(readFileSync(join(path, '_contract.md'), 'utf8'));
    assert.ok(contract.ok);
    assert.deepEqual(contract.value.frontmatter['vault'], { id: 'notes', purpose: { summary: 'The notes vault.' }, audience: 'alice', owners: ['alice'], actors: [] });
    assert.deepEqual(contract.value.frontmatter['merge'], [{ paths: ['**'], require: ['checks', 'owner'] }]);
    const status = await integrityStatus(git, state.value, { id: 'notes', path });
    assert.equal(status.ok && status.value.state, 'accepted');
    assert.equal(created.value.accepted.how, 'init');

    mkdirSync(dir.file('occupied'));
    writeFileSync(dir.file('occupied', 'x'), 'x');
    assert.deepEqual(await createEmptyVault(deps, { path: dir.file('occupied'), id: 'other', by: 'alice' }), { ok: false, error: { reason: 'not-empty', path: dir.file('occupied') } });
    const badId = await createEmptyVault(deps, { path: dir.file('bad'), id: 'not ok', by: 'alice' });
    assert.equal(!badId.ok && badId.error.reason, 'invalid-argument');
    assert.equal(existsSync(dir.file('bad')), false);
  } finally {
    state.value.close();
  }
}));
