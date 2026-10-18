// Documented behaviour: cli.md "Installation of the command" — Pi does not put
// package executables on PATH, so `/vault install-cli` writes a small
// launcher to a user directory on PATH: `~/.local/bin/vault` on Linux and
// macOS, `vault.cmd` under `%LOCALAPPDATA%` on Windows. It is an explicit
// command, never an install script (pi-conventions.md "Packaging"), and it
// never replaces a `vault` that is not its own. It says when another `vault` is
// on PATH, and which one runs: the first on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeLauncher, launcherFor, vaultsOnPath, writeLauncher } from '../../../src/core/config/index.ts';
import { makeExecutable } from '../../support/executables.ts';
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
    assert.deepEqual(written.value, { path: join(home, '.local', 'bin', 'vault'), onPath: true, replaced: false, others: [], runs: join(home, '.local', 'bin', 'vault') });
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

test('every other vault on PATH is named, and the first on PATH is the one that runs', posixOnly, withTempDir((dir) => {
  const home = dir.file('home');
  const own = join(home, '.local', 'bin', 'vault');
  const early = makeExecutable(dir.file('early'), 'vault');
  const late = makeExecutable(dir.file('late'), 'vault');

  const shadowed = writeLauncher(testHost({ home, env: { PATH: [dir.file('early'), join(home, '.local', 'bin'), dir.file('late')].join(':') } }), PROGRAM);
  assert.ok(shadowed.ok);
  assert.deepEqual([shadowed.value.others, shadowed.value.runs], [[early, late], early]);
  const text = describeLauncher(shadowed.value);
  assert.ok(text.includes(`Wrote ${own}.`), text);
  assert.ok(text.includes(`${early} comes first on PATH, so it runs, not this launcher`), text);
  assert.ok(text.includes(late) && text.includes('Put ' + join(home, '.local', 'bin') + ' before'), text);

  const first = writeLauncher(testHost({ home, env: { PATH: [join(home, '.local', 'bin'), dir.file('late')].join(':') } }), PROGRAM);
  assert.ok(first.ok);
  assert.deepEqual([first.value.others, first.value.runs], [[late], own]);
  const firstText = describeLauncher(first.value);
  assert.ok(firstText.includes(`The launcher comes first on PATH, so it runs; ${late} is behind it.`), firstText);

  const off = writeLauncher(testHost({ home, env: { PATH: dir.file('late') } }), PROGRAM);
  assert.ok(off.ok);
  assert.deepEqual([off.value.onPath, off.value.others, off.value.runs], [false, [late], late]);
  const offText = describeLauncher(off.value);
  assert.ok(offText.includes('not on PATH') && offText.includes(`${late} is the vault that runs`), offText);

  const alone = writeLauncher(testHost({ home, env: { PATH: '/usr/bin' } }), PROGRAM);
  assert.ok(alone.ok);
  assert.deepEqual([alone.value.others, alone.value.runs], [[], undefined]);
  assert.equal(describeLauncher(alone.value), `Wrote ${own}. Its directory is not on PATH yet; add it to run "vault" by name.`);
}));

test('on Windows, vault.cmd, vault.exe and vault.bat are the vaults on PATH', () => {
  const files = new Set(['C:\\tools\\vault.exe', 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\vault.cmd']);
  const fs = { exists: (path: string) => files.has(path), real: (path: string) => path };
  const host = testHost({ os: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', Path: 'C:\\tools;C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps' } });
  const found = vaultsOnPath(host, 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps\\vault.cmd', fs);
  assert.deepEqual(found, { others: ['C:\\tools\\vault.exe'], runs: 'C:\\tools\\vault.exe' });
});
