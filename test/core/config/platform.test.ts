// Documented behaviour: architecture.md "Data locations" — each platform's own
// config and state directories for the application, with environment overrides,
// private to the user. Windows and macOS branches run through injected hosts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrivateDir, installationPaths, landsWithin, platformDirs, realLocation } from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir } from '../../support/temp-dir.ts';

function dirs(host = testHost()) {
  const result = platformDirs(host);
  if (!result.ok) assert.fail(`expected directories, got ${JSON.stringify(result.error)}`);
  return result.value;
}

test('Linux uses the XDG config and state directories, with the documented defaults', () => {
  assert.deepEqual(dirs(testHost()), {
    config: '/home/alice/.config/pi-active-vaults',
    state: '/home/alice/.local/state/pi-active-vaults',
  });
  assert.deepEqual(dirs(testHost({ env: { XDG_CONFIG_HOME: '/xdg/c', XDG_STATE_HOME: '/xdg/s' } })), {
    config: '/xdg/c/pi-active-vaults',
    state: '/xdg/s/pi-active-vaults',
  });
});

test('a relative XDG directory is ignored, as the XDG specification requires', () => {
  const result = dirs(testHost({ env: { XDG_CONFIG_HOME: 'relative/dir', XDG_STATE_HOME: '' } }));
  assert.equal(result.config, '/home/alice/.config/pi-active-vaults');
  assert.equal(result.state, '/home/alice/.local/state/pi-active-vaults');
});

test('macOS keeps config and state under Application Support', () => {
  const host = testHost({ os: 'darwin', home: '/Users/alice' });
  const expected = '/Users/alice/Library/Application Support/pi-active-vaults';
  assert.deepEqual(dirs(host), { config: expected, state: expected });
});

test('Windows uses %APPDATA% for config and %LOCALAPPDATA% for state, with backslash paths', () => {
  const host = testHost({
    os: 'win32',
    home: 'C:\\Users\\alice',
    env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming', LOCALAPPDATA: 'D:\\Local' },
  });
  assert.deepEqual(dirs(host), {
    config: 'C:\\Users\\alice\\AppData\\Roaming\\pi-active-vaults',
    state: 'D:\\Local\\pi-active-vaults',
  });
});

test('Windows falls back to the profile directory when the variables are missing', () => {
  const host = testHost({ os: 'win32', home: 'C:\\Users\\alice' });
  assert.deepEqual(dirs(host), {
    config: 'C:\\Users\\alice\\AppData\\Roaming\\pi-active-vaults',
    state: 'C:\\Users\\alice\\AppData\\Local\\pi-active-vaults',
  });
});

test('PI_ACTIVE_VAULTS_CONFIG and PI_ACTIVE_VAULTS_STATE override the directories on every platform', () => {
  for (const os of ['linux', 'darwin', 'win32'] as const) {
    const abs = os === 'win32' ? 'E:\\cfg' : '/override/cfg';
    const absState = os === 'win32' ? 'E:\\st' : '/override/st';
    const result = dirs(testHost({ os, env: { PI_ACTIVE_VAULTS_CONFIG: abs, PI_ACTIVE_VAULTS_STATE: absState } }));
    assert.deepEqual(result, { config: abs, state: absState }, os);
  }
});

test('a relative override is refused rather than resolved against an unknown directory', () => {
  const result = platformDirs(testHost({ env: { PI_ACTIVE_VAULTS_STATE: 'state' } }));
  assert.deepEqual(result, { ok: false, error: { reason: 'relative-override', variable: 'PI_ACTIVE_VAULTS_STATE' } });
});

test('the installation files live at the documented places under those directories', () => {
  const posix = installationPaths({ config: '/c', state: '/s' }, 'linux');
  assert.deepEqual(posix, {
    configFile: '/c/config.yaml',
    stateDb: '/s/state.sqlite',
    indexDb: '/s/index.sqlite',
    logs: '/s/logs',
    worktrees: '/s/worktrees',
    socket: '/s/daemon.sock',
    runs: '/s/runs',
    refs: '/s/refs',
  });
  assert.equal(installationPaths({ config: 'C:\\c', state: 'C:\\s' }, 'win32').stateDb, 'C:\\s\\state.sqlite');
  // A named pipe on Windows, unique to the state directory, so two installations never share one.
  const pipe = installationPaths({ config: 'C:\\c', state: 'C:\\s' }, 'win32').socket;
  assert.match(pipe, /^\\\\\.\\pipe\\pi-active-vaults-[0-9a-f]{16}$/);
  assert.notEqual(installationPaths({ config: 'C:\\c', state: 'C:\\t' }, 'win32').socket, pipe);
  assert.equal(installationPaths({ config: 'C:\\c', state: 'C:\\s' }, 'win32').worktrees, 'C:\\s\\worktrees');
});

test('private directories are created accessible to the user only (POSIX modes)', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pav-dirs-'));
  try {
    const target = join(root, 'a', 'b');
    ensurePrivateDir(target);
    assert.equal(statSync(target).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 'a')).mode & 0o777, 0o700);
    ensurePrivateDir(target); // idempotent
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a path\'s real location follows links in every directory on the way that exists, and keeps the rest as written', { skip: process.platform === 'win32' ? 'symbolic links need privileges' : false }, withTempDir((dir) => {
  mkdirSync(dir.file('real', 'sub'), { recursive: true });
  symlinkSync(dir.file('real'), dir.file('link'));
  const base = realpathSync.native(dir.path);
  assert.equal(realLocation(dir.file('link', 'sub', 'new', 'file.md')), join(base, 'real', 'sub', 'new', 'file.md'));
  assert.equal(realLocation(dir.file('link')), join(base, 'real'));
  assert.equal(realLocation(dir.file('link', '..', 'real')), join(base, 'real'), 'resolved as written first, as the system would');
}));

test('a path lands within a directory when its real location is inside it', { skip: process.platform === 'win32' ? 'symbolic links need privileges' : false }, withTempDir((dir) => {
  mkdirSync(dir.file('root', 'docs'), { recursive: true });
  mkdirSync(dir.file('elsewhere'));
  symlinkSync(dir.file('elsewhere'), dir.file('root', 'out'));
  assert.equal(landsWithin(dir.file('root'), dir.file('root', 'docs', 'a.md')), 'docs/a.md');
  assert.equal(landsWithin(dir.file('root'), dir.file('root')), '');
  assert.equal(landsWithin(dir.file('root'), dir.file('root', 'out', 'a.md')), undefined, 'through a link out');
  assert.equal(landsWithin(dir.file('root'), dir.file('root', '..', 'elsewhere')), undefined);
  assert.equal(landsWithin(dir.file('root'), dir.file('root', '..foo')), '..foo', 'a name starting with two dots is inside');
}));
