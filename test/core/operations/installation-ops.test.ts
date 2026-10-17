// Documented behaviour: cli.md "Vaults and installation" — `init` creates a
// vault, empty or from a template, and registers it; `add` registers an
// existing vault; `list` shows the registered vaults and their catalog
// entries; `whoami` prints the installation's name. daemon.md "Hosting" — the
// name defaults to <user>@<hostname>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unacceptedNotices } from '../../../src/core/operations/index.ts';
import { createTempRepo } from '../../support/git-repo.ts';
import { withInstallation } from '../../support/installation.ts';
import { rootContract } from '../../support/vault.ts';

test('whoami prints the installation\'s name', withInstallation(async (t) => {
  assert.deepEqual(await t.run('whoami'), { status: 'ok', text: 'alice@homeserver', data: { name: 'alice@homeserver', person: 'alice' } });
}));

test('init creates an empty vault owned by the person, accepted and registered; a used id is refused before anything is made', withInstallation(async (t) => {
  const path = t.dir.file('vaults', 'notes');
  const created = await t.run('init', { path });
  assert.equal(created.status, 'ok', created.text);
  assert.ok(existsSync(join(path, '_contract.md')));
  const next = t.reload();
  assert.deepEqual(next.installation.vaults.map((v) => v.id), ['home', 'notes']);
  assert.deepEqual(await unacceptedNotices(next.context, next.installation.vaults), [], 'its first commit is accepted');
  const again = await next.run('init', { path: t.dir.file('vaults', 'other'), id: 'notes' });
  assert.equal(again.status, 'failed');
  assert.equal(existsSync(t.dir.file('vaults', 'other')), false);
}));

test('add registers an existing vault by the id its root contract declares, unaccepted until an owner adopts it', withInstallation(async (t) => {
  const other = createTempRepo();
  try {
    other.write('_contract.md', rootContract({ id: 'garden' }));
    other.commit('Create vault');
    const added = await t.run('add', { path: other.path });
    assert.equal(added.status, 'ok', added.text);
    const next = t.reload();
    assert.deepEqual(next.installation.vaults.map((v) => v.id), ['home', 'garden']);
    const notices = await unacceptedNotices(next.context, next.installation.vaults);
    assert.deepEqual(notices.map((n) => [n.vault, n.change.change]), [['garden', 'none-accepted']]);
    assert.match(notices[0]?.notice ?? '', /vault accept --adopt [0-9a-f]{40}/);
    const listed = await next.run('list');
    assert.match(listed.text, /^home {2}.*\n {2}Home things\. — for household; local review; owners alice\ngarden/);
  } finally {
    other.cleanup();
  }
}));

test('template show summarises a template; init --template creates a vault from it, by name from the config', withInstallation(async (t) => {
  const template = createTempRepo();
  try {
    template.write('_contract.md', [
      '---', 'template: { name: digests, version: 1, summary: Research digests. }',
      'vault:', '  id: digests', '  purpose: { summary: Digests. }', '  audience: me', '  owners: [alice]', '  actors: [researcher]', '---', '',
    ].join('\n'));
    template.write('topics/README.md', '# Topics\n');
    template.commit('template');
    const shown = await t.run('template-show', { template: template.path });
    assert.equal(shown.status, 'ok', shown.text);
    assert.match(shown.text, /^digests version 1: Research digests\.\n {2}at [0-9a-f]{40}; 2 files/);
    assert.equal((await t.run('template-show', { template: t.repo.path })).status, 'failed', 'a vault that is not marked as a template');

    // The template's path is known only now: name it in the config, as a user would.
    const configFile = t.installation.paths.configFile;
    writeFileSync(configFile, readFileSync(configFile, 'utf8').replace('TEMPLATE_PATH', JSON.stringify(template.path)));
    const next = t.reload();
    const made = await next.run('init', { path: t.dir.file('mine'), template: 'digests', id: 'mine' });
    assert.equal(made.status, 'ok', made.text);
    assert.ok(existsSync(join(t.dir.file('mine'), 'topics', 'README.md')));
    assert.deepEqual(next.reload().installation.vaults.map((v) => v.id), ['home', 'mine']);
  } finally {
    template.cleanup();
  }
}, { config: 'templates: { digests: TEMPLATE_PATH }' }));
