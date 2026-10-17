// Documented behaviour: concepts.md "Installation" — the config is validated
// strictly when loaded, and every problem is listed; notifications.md — the
// notify section, recipients included, is validated when the config loads;
// mcp.md — so are the MCP profiles. A machine without a config file is an
// installation with no vaults (missing pieces reduce capability).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadInstallation } from '../../../src/core/operations/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir, type TempDir } from '../../support/temp-dir.ts';

const hostIn = (dir: TempDir) => testHost({ env: { PI_ACTIVE_VAULTS_CONFIG: dir.file('config'), PI_ACTIVE_VAULTS_STATE: dir.file('state') } });

function writeConfig(dir: TempDir, lines: readonly string[]): void {
  mkdirSync(dir.file('config'), { recursive: true });
  writeFileSync(dir.file('config', 'config.yaml'), lines.join('\n'));
}

test('an installation is loaded with its paths, vaults, notify and MCP sections', withTempDir((dir) => {
  writeConfig(dir, [
    'installation: { person: alice }',
    'vaults: [{ id: home, path: /srv/vaults/home }]',
    'notify:',
    '  from: "Vault <vault@example.net>"',
    '  recipients: { me: me@example.net }',
    '  transport: { type: smtp, host: smtp.example.net, port: 587, user: vault@example.net, password: "${SMTP_PASSWORD}" }',
    'mcp: { profiles: [{ name: chat, permissions: ["@read"] }] }',
  ]);
  const loaded = loadInstallation(hostIn(dir));
  assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.error));
  const installation = loaded.value;
  assert.deepEqual(installation.vaults.map((v) => [v.id, v.path, v.worktrees]), [['home', '/srv/vaults/home', `${dir.path}/state/worktrees/home`]]);
  assert.equal(installation.notify?.transport.type, 'smtp');
  assert.deepEqual(installation.mcp.profiles.map((p) => p.name), ['chat']);
  assert.equal(installation.paths.stateDb, `${dir.path}/state/state.sqlite`);
  assert.equal(installation.configFound, true);
}));

test('no config file is an installation with no vaults, nothing configured', withTempDir((dir) => {
  const loaded = loadInstallation(hostIn(dir));
  assert.ok(loaded.ok);
  assert.deepEqual([loaded.value.vaults, loaded.value.notify, loaded.value.mcp.profiles, loaded.value.configFound], [[], undefined, [], false]);
  assert.equal(loaded.value.config.name, 'alice@homeserver');
}));

test('problems in the notify and mcp sections are listed with the rest, without their values', withTempDir((dir) => {
  writeConfig(dir, [
    'vaults: [{ id: home, path: /srv/vaults/home }]',
    'notify:',
    '  from: "Vault <vault@example.net>"',
    '  recipients: { me: "me@example.net, mallory@example.net" }',
    '  transport: { type: smtp, host: smtp.example.net, port: 25, user: u, password: "${P}" }',
    'mcp: { profiles: [{ name: chat, permissions: ["@all"], vaults: { elsewhere: [read] } }] }',
  ]);
  const loaded = loadInstallation(hostIn(dir));
  assert.ok(!loaded.ok);
  assert.equal(loaded.error.reason, 'invalid');
  const paths = loaded.error.reason === 'invalid' ? loaded.error.issues.map((i) => i.path) : [];
  assert.deepEqual(paths, ['notify.recipients.me', 'notify.transport.port', 'mcp.profiles[0].permissions[0]', 'mcp.profiles[0].vaults.elsewhere']);
  assert.ok(!JSON.stringify(loaded.error).includes('mallory'));
}));

test('a relative directory override is refused before anything is read', () => {
  const loaded = loadInstallation(testHost({ env: { PI_ACTIVE_VAULTS_STATE: 'state' } }));
  assert.deepEqual(loaded, { ok: false, error: { reason: 'relative-override', variable: 'PI_ACTIVE_VAULTS_STATE' } });
});
