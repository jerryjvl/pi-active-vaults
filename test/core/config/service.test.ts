// Documented behaviour: daemon.md "Service installation" — `vault daemon
// install` writes a definition for the platform: a systemd user unit on
// Linux, a launchd agent on macOS, a Task Scheduler task at logon on Windows;
// the service runs a launcher that resolves the current Node and `pi` at
// start, so upgrades do not break it. architecture.md "Process model" — the
// daemon runs the user's own Pi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPi, serviceFor } from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const PROGRAM = '/opt/pkg/dist/cli/main.js';
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX file system' : false };

test('Linux: a systemd user unit that runs the daemon through a login shell, finding node at start', () => {
  const service = serviceFor(testHost({ env: { XDG_CONFIG_HOME: '/home/alice/.config' } }), PROGRAM, { state: '/s' });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, '/home/alice/.config/systemd/user/pi-active-vaults.service');
  assert.match(text, /^\[Unit\]/m);
  assert.match(text, /^ExecStart=\/bin\/sh -lc 'exec node "\$\$0" daemon run' "\/opt\/pkg\/dist\/cli\/main\.js"$/m);
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.deepEqual(commands.start, [{ file: 'systemctl', args: ['--user', 'start', 'pi-active-vaults.service'] }]);
  assert.deepEqual(commands.install.map((c) => c.args.join(' ')), ['--user daemon-reload', '--user enable pi-active-vaults.service']);
});

test('a path with characters systemd or a shell would read is written so they read it as a path', () => {
  const service = serviceFor(testHost(), '/opt/my "pkg"/100%/$HOME\\main.js', { state: '/s' });
  assert.ok(service.ok);
  assert.match(service.value.text, /^ExecStart=\/bin\/sh -lc 'exec node "\$\$0" daemon run' "\/opt\/my \\"pkg\\"\/100%%\/\$\$HOME\\\\main\.js"$/m);
  assert.deepEqual(serviceFor(testHost(), '/opt/pkg\nExecStartPost=/bin/evil', { state: '/s' }), { ok: false, error: { reason: 'unsafe-path', program: '/opt/pkg\nExecStartPost=/bin/evil' } });
});

test('macOS: a launchd agent, kept alive, its output in the state directory', () => {
  const service = serviceFor(testHost({ os: 'darwin', home: '/Users/alice' }), '/opt/a&b/main.js', { state: '/s', uid: 501 });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, '/Users/alice/Library/LaunchAgents/pi-active-vaults.daemon.plist');
  assert.match(text, /<key>Label<\/key>\s*<string>pi-active-vaults\.daemon<\/string>/);
  assert.match(text, /<string>\/bin\/sh<\/string>\s*<string>-lc<\/string>\s*<string>exec node "\$0" daemon run<\/string>\s*<string>\/opt\/a&amp;b\/main\.js<\/string>/);
  assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>\/s\/logs\/daemon\.err<\/string>/);
  assert.deepEqual(commands.install, [{ file: '/bin/launchctl', args: ['bootstrap', 'gui/501', file] }]);
  assert.deepEqual(commands.stop, [{ file: '/bin/launchctl', args: ['kill', 'SIGTERM', 'gui/501/pi-active-vaults.daemon'] }]);
});

test('Windows: a Task Scheduler task at logon, registered with schtasks by its absolute path', () => {
  const host = testHost({ os: 'win32', home: 'C:\\Users\\alice', user: 'alice', env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' } });
  const service = serviceFor(host, 'C:\\pkg\\dist\\cli\\main.js', { state: 'C:\\s' });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, 'C:\\s\\pi-active-vaults-task.xml');
  assert.match(text, /<LogonTrigger>/);
  assert.match(text, /<Command>cmd\.exe<\/Command>\s*<Arguments>\/d \/c node "C:\\pkg\\dist\\cli\\main\.js" daemon run<\/Arguments>/);
  assert.deepEqual(commands.install, [{ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/Create', '/TN', 'pi-active-vaults', '/XML', file, '/F'] }]);
  assert.deepEqual(serviceFor(host, 'C:\\pkg "x"\\main.js', { state: 'C:\\s' }).ok, false, 'a path cmd.exe cannot quote is refused');
});

test('the user\'s pi is found on PATH; a JavaScript entry point runs with node', posixOnly, withTempDir((dir) => {
  const bin = dir.file('bin');
  const pkg = dir.file('lib', 'pi-coding-agent', 'dist');
  mkdirSync(bin, { recursive: true });
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'cli.js'), '#!/usr/bin/env node\n');
  symlinkSync(join(pkg, 'cli.js'), join(bin, 'pi'));
  const host = testHost({ env: { PATH: `/nonexistent:${bin}` } });
  assert.deepEqual(findPi(host, '/usr/bin/node'), { ok: true, value: { file: '/usr/bin/node', args: [join(pkg, 'cli.js')] } });
  const other = dir.file('other');
  mkdirSync(other);
  writeFileSync(join(other, 'pi'), '#!/bin/sh\n');
  chmodSync(join(other, 'pi'), 0o755);
  assert.deepEqual(findPi(testHost({ env: { PATH: other } }), '/usr/bin/node'), { ok: true, value: { file: join(other, 'pi'), args: [] } });
  assert.deepEqual(findPi(testHost({ env: { PATH: '/nonexistent' } }), '/usr/bin/node'), { ok: false, error: { reason: 'pi-not-found' } });
}));

test('on Windows, pi is the package npm installed beside pi.cmd, run with node', () => {
  const npm = 'C:\\Users\\alice\\AppData\\Roaming\\npm';
  const cli = `${npm}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js`;
  const files = new Set([`${npm}\\pi.cmd`, cli]);
  const host = testHost({ os: 'win32', env: { Path: `C:\\nowhere;${npm}` } });
  const fs = { exists: (path: string) => files.has(path), real: (path: string) => path };
  assert.deepEqual(findPi(host, 'C:\\node\\node.exe', fs), { ok: true, value: { file: 'C:\\node\\node.exe', args: [cli] } });
  assert.deepEqual(findPi(testHost({ os: 'win32', env: { Path: 'C:\\nowhere' } }), 'C:\\node\\node.exe', fs), { ok: false, error: { reason: 'pi-not-found' } });
});
