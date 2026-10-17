// Documented behaviour: cli.md "Vaults and installation" — `vault init` and
// `vault add` register a vault in the installation config. The file stays
// the user's: comments and layout are kept, the entry is added only when the
// result is still a valid config (an existing id or path is refused, never
// overwritten), and a new file is private to the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { loadInstallationConfig, registerVault } from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const host = testHost({ home: '/home/alice' });

test('a vault is added to an existing config, keeping its comments and layout', withTempDir((dir) => {
  const file = dir.file('config.yaml');
  writeFileSync(file, '# my installation\ninstallation:\n  person: alice   # me\nvaults:\n  - id: home\n    path: ~/vaults/home\n');
  const added = registerVault(file, host, { id: 'work', path: '/srv/vaults/work' });
  assert.deepEqual(added, { ok: true, value: undefined });
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# my installation\n/);
  assert.match(text, /person: alice {3}# me/);
  const loaded = loadInstallationConfig(file, host);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.value.vaults.map((v) => [v.id, v.path]), [['home', '/home/alice/vaults/home'], ['work', '/srv/vaults/work']]);
}));

test('a missing config is created, private to the user, holding just the vault', withTempDir((dir) => {
  const file = dir.file('nested', 'config.yaml');
  assert.ok(registerVault(file, host, { id: 'home', path: '/srv/vaults/home', worktrees: '/srv/worktrees/home' }).ok);
  const loaded = loadInstallationConfig(file, host);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.value.vaults, [{ id: 'home', path: '/srv/vaults/home', worktrees: '/srv/worktrees/home', host: false }]);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
}));

test('a vault id or path already registered is refused, and the file is left as it was', withTempDir((dir) => {
  const file = dir.file('config.yaml');
  const original = 'vaults:\n  - id: home\n    path: /srv/vaults/home\n';
  writeFileSync(file, original);
  assert.deepEqual(registerVault(file, host, { id: 'home', path: '/srv/vaults/other' }), { ok: false, error: { reason: 'already-registered', id: 'home' } });
  assert.deepEqual(registerVault(file, host, { id: 'other', path: '/srv/vaults/home' }), { ok: false, error: { reason: 'path-registered', id: 'home' } });
  assert.equal(readFileSync(file, 'utf8'), original);
}));

test('an invalid config is not edited: registering reports its problems and changes nothing', withTempDir((dir) => {
  const file = dir.file('config.yaml');
  const original = 'vaults: []\nmodles: {}\n';
  writeFileSync(file, original);
  const refused = registerVault(file, host, { id: 'home', path: '/srv/vaults/home' });
  assert.equal(!refused.ok && refused.error.reason, 'invalid');
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(registerVault(dir.file('x.yaml'), host, { id: 'bad id', path: '/srv/v' }).ok, false, 'an invalid entry is never written');
  assert.equal(existsSync(dir.file('x.yaml')), false);
}));
