// Documented behaviour: cli.md "Installation of the command" — Pi does not put
// package executables on PATH, so `/vault install-cli` writes a small
// launcher to a user directory on PATH: `~/.local/bin/vault` on Linux and
// macOS, `vault.cmd` under `%LOCALAPPDATA%` on Windows. It is an explicit
// command, never an install script (pi-conventions.md "Packaging"), and it
// never replaces a `vault` that is not its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeLauncher } from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const PROGRAM = '/opt/pkg/dist/cli/main.js';

test('on Linux and macOS the launcher is ~/.local/bin/vault, an executable that runs the CLI with node', withTempDir((dir) => {
  for (const os of ['linux', 'darwin'] as const) {
    const home = dir.file(os);
    const host = testHost({ os, home, env: { PATH: `/usr/bin:${join(home, '.local', 'bin')}` } });
    const written = writeLauncher(host, PROGRAM);
    assert.ok(written.ok, JSON.stringify(!written.ok && written.error));
    assert.deepEqual(written.value, { path: join(home, '.local', 'bin', 'vault'), onPath: true, replaced: false });
    const text = readFileSync(written.value.path, 'utf8');
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text, /exec node '\/opt\/pkg\/dist\/cli\/main\.js' "\$@"/);
    if (process.platform !== 'win32') assert.equal(statSync(written.value.path).mode & 0o777, 0o755);
  }
}));

test('on Windows the launcher is vault.cmd under %LOCALAPPDATA%', withTempDir((dir) => {
  const local = dir.file('Local');
  const host = testHost({ os: 'win32', home: dir.path, env: { LOCALAPPDATA: local, PATH: 'C:\\Windows' } });
  const written = writeLauncher(host, 'C:\\pkg\\dist\\cli\\main.js');
  assert.ok(written.ok);
  assert.equal(written.value.path, join(local, 'Microsoft', 'WindowsApps', 'vault.cmd'));
  assert.equal(written.value.onPath, false, 'reported, so the person can add it');
  assert.match(readFileSync(written.value.path, 'utf8'), /^@echo off\r\n.*\r\nnode "C:\\pkg\\dist\\cli\\main\.js" %\*\r\n$/);
}));

test('writing it again replaces the launcher; a vault that is not a launcher is never replaced', withTempDir((dir) => {
  const home = dir.file('home');
  const host = testHost({ home, env: { PATH: '' } });
  assert.ok(writeLauncher(host, PROGRAM).ok);
  const again = writeLauncher(host, '/elsewhere/main.js');
  assert.ok(again.ok && again.value.replaced);
  const theirs = join(home, '.local', 'bin', 'vault');
  writeFileSync(theirs, '#!/bin/sh\necho mine\n');
  const refused = writeLauncher(host, PROGRAM);
  assert.deepEqual(!refused.ok && refused.error, { reason: 'occupied', path: theirs });
  assert.equal(readFileSync(theirs, 'utf8'), '#!/bin/sh\necho mine\n');
}));

test('a program path that a shell would read as more than a path is quoted safely', withTempDir((dir) => {
  const host = testHost({ home: dir.path, env: { PATH: '' } });
  const written = writeLauncher(host, "/opt/it's $HOME/`id`/main.js");
  assert.ok(written.ok);
  assert.match(readFileSync(written.value.path, 'utf8'), /exec node '\/opt\/it'\\''s \$HOME\/`id`\/main\.js' "\$@"/);
  const windows = writeLauncher(testHost({ os: 'win32', home: dir.path, env: { LOCALAPPDATA: dir.file('L') } }), 'C:\\a "b"\\main.js');
  assert.deepEqual(!windows.ok && windows.error.reason, 'unsafe-path');
}));
