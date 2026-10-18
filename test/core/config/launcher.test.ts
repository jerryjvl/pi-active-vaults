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
import { launcherFor, writeLauncher } from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const PROGRAM = '/opt/pkg/dist/cli/main.js';
/** POSIX launchers are written for real, which needs a POSIX file system. */
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX paths' : false };

test('on Linux and macOS the launcher is ~/.local/bin/vault, an executable that runs the CLI with node', posixOnly, withTempDir((dir) => {
  for (const os of ['linux', 'darwin'] as const) {
    const home = dir.file(os);
    const host = testHost({ os, home, env: { PATH: `/usr/bin:${join(home, '.local', 'bin')}` } });
    const written = writeLauncher(host, PROGRAM);
    assert.ok(written.ok, JSON.stringify(!written.ok && written.error));
    assert.deepEqual(written.value, { path: join(home, '.local', 'bin', 'vault'), onPath: true, replaced: false });
    const text = readFileSync(written.value.path, 'utf8');
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.match(text, /exec node '\/opt\/pkg\/dist\/cli\/main\.js' "\$@"/);
    assert.equal(statSync(written.value.path).mode & 0o777, 0o755);
  }
}));

test('on Windows the launcher is vault.cmd under %LOCALAPPDATA%', () => {
  // Through the injected host only: a Windows path cannot be written from another platform.
  const host = testHost({ os: 'win32', home: 'C:\\Users\\alice', env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' } });
  const launcher = launcherFor(host, 'C:\\pkg\\dist\\cli\\main.js');
  assert.ok(launcher.ok);
  assert.equal(launcher.value.file, 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\vault.cmd');
  assert.match(launcher.value.text, /^@echo off\r\n.*\r\nnode "C:\\pkg\\dist\\cli\\main\.js" %\*\r\n$/);
  assert.equal(launcherFor(host, 'C:\\a "b"\\main.js').ok, false, 'a quote cmd.exe cannot hold');
  assert.equal(launcherFor(testHost({ os: 'win32' }), 'C:\\main.js').ok, false, 'no LOCALAPPDATA');
});

test('writing it again replaces the launcher; a vault that is not a launcher is never replaced', posixOnly, withTempDir((dir) => {
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

test('a program path that a shell would read as more than a path is quoted safely', posixOnly, withTempDir((dir) => {
  const host = testHost({ home: dir.path, env: { PATH: '' } });
  const written = writeLauncher(host, "/opt/it's $HOME/`id`/main.js");
  assert.ok(written.ok);
  assert.match(readFileSync(written.value.path, 'utf8'), /exec node '\/opt\/it'\\''s \$HOME\/`id`\/main\.js' "\$@"/);
}));
