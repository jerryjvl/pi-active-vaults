// Documented behaviour: daemon.md "Service installation" — `vault daemon
// install` writes a definition for the platform: a systemd user unit on
// Linux, a launchd agent on macOS (a launchd daemon run as the user on a
// headless Mac), a Task Scheduler task at logon on Windows;
// the service runs a launcher that resolves the current Node and `pi` at
// start, so upgrades do not break it. architecture.md "Process model" — the
// daemon runs the user's own Pi. The service is given the PATH it needs: the
// directories in which node, pi and git were found on PATH at install time,
// as found — not resolved through links, so a version manager's `latest` keeps
// working across upgrades — ahead of the platform's usual ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPi, findServiceTools, serviceFor, staleServiceTools, type ServiceTool } from '../../../src/core/config/index.ts';
import { testHost } from '../../support/host.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const PROGRAM = '/opt/pkg/dist/cli/main.js';
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX file system' : false };

const TOOLS: readonly ServiceTool[] = [{ tool: 'node', dir: '/home/alice/.local/share/mise/installs/node/latest/bin' }, { tool: 'pi', dir: '/opt/pi/bin' }];

test('Linux: a systemd user unit that runs the daemon with the recorded PATH, finding node when it starts', () => {
  const service = serviceFor(testHost({ env: { XDG_CONFIG_HOME: '/home/alice/.config' } }), PROGRAM, { state: '/s', tools: TOOLS });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, '/home/alice/.config/systemd/user/pi-active-vaults.service');
  assert.match(text, /^\[Unit\]/m);
  assert.match(text, /^Environment="PATH=\/home\/alice\/\.local\/share\/mise\/installs\/node\/latest\/bin:\/opt\/pi\/bin:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"$/m);
  assert.match(text, /^ExecStart=\/bin\/sh -c 'exec node "\$\$0" daemon run' "\/opt\/pkg\/dist\/cli\/main\.js"$/m, 'no login shell: it would rebuild PATH without the version manager');
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.deepEqual(commands.start, [{ file: 'systemctl', args: ['--user', 'start', 'pi-active-vaults.service'] }]);
  assert.deepEqual(commands.install.map((c) => c.args.join(' ')), ['--user daemon-reload', '--user enable pi-active-vaults.service']);
});

test('a path with characters systemd or a shell would read is written so they read it as a path', () => {
  const service = serviceFor(testHost(), '/opt/my "pkg"/100%/$HOME\\main.js', { state: '/s' });
  assert.ok(service.ok);
  assert.match(service.value.text, /^ExecStart=\/bin\/sh -c 'exec node "\$\$0" daemon run' "\/opt\/my \\"pkg\\"\/100%%\/\$\$HOME\\\\main\.js"$/m);
  assert.deepEqual(serviceFor(testHost(), '/opt/pkg\nExecStartPost=/bin/evil', { state: '/s' }), { ok: false, error: { reason: 'unsafe-path', program: '/opt/pkg\nExecStartPost=/bin/evil' } });
});

test('macOS: a launchd agent, kept alive, its output in the state directory', () => {
  const service = serviceFor(testHost({ os: 'darwin', home: '/Users/alice' }), '/opt/a&b/main.js', { state: '/s', uid: 501, tools: [{ tool: 'node', dir: '/Users/alice/.local/share/mise/shims' }] });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, '/Users/alice/Library/LaunchAgents/pi-active-vaults.daemon.plist');
  assert.match(text, /<key>Label<\/key>\s*<string>pi-active-vaults\.daemon<\/string>/);
  assert.match(text, /<string>\/bin\/sh<\/string>\s*<string>-c<\/string>\s*<string>exec node "\$0" daemon run<\/string>\s*<string>\/opt\/a&amp;b\/main\.js<\/string>/);
  assert.match(text, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/Users\/alice\/\.local\/share\/mise\/shims:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>\/s\/logs\/daemon\.err<\/string>/);
  assert.deepEqual(commands.install, [{ file: '/bin/launchctl', args: ['bootstrap', 'gui/501', file] }]);
  assert.deepEqual(commands.stop, [{ file: '/bin/launchctl', args: ['kill', 'SIGTERM', 'gui/501/pi-active-vaults.daemon'] }]);
});

test('macOS, headless: a launchd daemon in /Library/LaunchDaemons, run as the user with their home, in the system domain', () => {
  const service = serviceFor(testHost({ os: 'darwin', home: '/Users/alice', user: 'alice' }), '/opt/a&b/main.js', { state: '/s', uid: 501, headless: true, tools: [{ tool: 'node', dir: '/opt/homebrew/bin' }] });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, '/Library/LaunchDaemons/pi-active-vaults.daemon.plist');
  assert.match(text, /<key>UserName<\/key>\s*<string>alice<\/string>/);
  assert.match(text, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>HOME<\/key>\s*<string>\/Users\/alice<\/string>\s*<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:/);
  assert.match(text, /<string>exec node "\$0" daemon run<\/string>\s*<string>\/opt\/a&amp;b\/main\.js<\/string>/);
  assert.deepEqual(commands.install, [{ file: '/bin/launchctl', args: ['bootstrap', 'system', file] }]);
  assert.deepEqual(commands.start, [{ file: '/bin/launchctl', args: ['kickstart', 'system/pi-active-vaults.daemon'] }]);
  assert.deepEqual(serviceFor(testHost({ os: 'darwin', home: '/Users/a<b', user: 'a<b' }), PROGRAM, { state: '/s', headless: true }).ok, true, 'escaped like any value');
  for (const os of ['linux', 'win32'] as const) {
    assert.deepEqual(serviceFor(testHost({ os, env: { SystemRoot: 'C:\\Windows' } }), PROGRAM, { state: '/s', headless: true }), { ok: false, error: { reason: 'not-supported', os } }, os);
  }
});

test('Windows: a Task Scheduler task at logon, registered with schtasks by its absolute path', () => {
  const host = testHost({ os: 'win32', home: 'C:\\Users\\alice', user: 'alice', env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' } });
  const service = serviceFor(host, 'C:\\pkg\\dist\\cli\\main.js', { state: 'C:\\s', tools: [{ tool: 'node', dir: 'C:\\Users\\alice\\AppData\\Local\\fnm\\aliases\\default' }, { tool: 'pi', dir: 'C:\\Users\\alice\\AppData\\Roaming\\npm' }] });
  assert.ok(service.ok);
  const { file, text, commands } = service.value;
  assert.equal(file, 'C:\\s\\pi-active-vaults-task.xml');
  assert.match(text, /<LogonTrigger>/);
  assert.match(text, /<Command>cmd\.exe<\/Command>\s*<Arguments>\/d \/c set "PATH=C:\\Users\\alice\\AppData\\Local\\fnm\\aliases\\default;C:\\Users\\alice\\AppData\\Roaming\\npm;%PATH%" &amp;&amp; node "C:\\pkg\\dist\\cli\\main\.js" daemon run<\/Arguments>/);
  assert.deepEqual(commands.install, [{ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/Create', '/TN', 'pi-active-vaults', '/XML', file, '/F'] }]);
  assert.deepEqual(serviceFor(host, 'C:\\pkg "x"\\main.js', { state: 'C:\\s' }).ok, false, 'a path cmd.exe cannot quote is refused');
  for (const dir of ['C:\\a "b"', 'C:\\100%', 'C:\\x\nset']) {
    assert.deepEqual(serviceFor(host, 'C:\\pkg\\main.js', { state: 'C:\\s', tools: [{ tool: 'node', dir }] }), { ok: false, error: { reason: 'unsafe-path', program: dir } }, dir);
  }
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

test('a directory a unit file would misread is escaped, or refused when it cannot be carried', () => {
  const service = serviceFor(testHost(), PROGRAM, { state: '/s', tools: [{ tool: 'node', dir: '/opt/100%/my "dir"' }] });
  assert.ok(service.ok);
  assert.match(service.value.text, /^Environment="PATH=\/opt\/100%%\/my \\"dir\\":/m);
  assert.deepEqual(serviceFor(testHost(), PROGRAM, { state: '/s', tools: [{ tool: 'node', dir: '/opt/x\nExecStartPost=/bin/evil' }] }), { ok: false, error: { reason: 'unsafe-path', program: '/opt/x\nExecStartPost=/bin/evil' } });
  const bare = serviceFor(testHost(), PROGRAM, { state: '/s' });
  assert.ok(bare.ok);
  assert.match(bare.value.text, /^Environment="PATH=\/usr\/local\/sbin:/m, 'with nothing found, the usual directories');
});

/** An executable file called `name` in `dir`. */
function makeTool(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '#!/bin/sh\n');
  chmodSync(join(dir, name), 0o755);
}

test('the directories of node, pi and git are those on PATH, as found: the first that holds each, links not followed', posixOnly, withTempDir((dir) => {
  const versions = dir.file('versions', '22.1.0', 'bin');
  makeTool(versions, 'node');
  const latest = dir.file('versions', 'latest');
  symlinkSync(dir.file('versions', '22.1.0'), latest);
  const other = dir.file('other');
  makeTool(other, 'node');
  makeTool(other, 'pi');
  const empty = dir.file('empty');
  mkdirSync(empty);
  const host = testHost({ env: { PATH: `/nonexistent:${empty}:${latest}/bin:${other}` } });
  assert.deepEqual(findServiceTools(host), [{ tool: 'node', dir: `${latest}/bin` }, { tool: 'pi', dir: other }], 'git is not on this PATH, so it has no entry');
  assert.notEqual(findServiceTools(host)[0]?.dir, versions, 'the link, not where it leads');
}));

test('a recorded directory that no longer holds its tool is stale', posixOnly, withTempDir((dir) => {
  const bin = dir.file('bin');
  makeTool(bin, 'node');
  makeTool(bin, 'pi');
  const recorded: ServiceTool[] = [{ tool: 'node', dir: bin }, { tool: 'pi', dir: bin }];
  const host = testHost();
  assert.deepEqual(staleServiceTools(recorded, host), []);
  rmSync(join(bin, 'pi'));
  assert.deepEqual(staleServiceTools(recorded, host), [{ tool: 'pi', dir: bin }]);
  rmSync(bin, { recursive: true });
  assert.deepEqual(staleServiceTools(recorded, host), recorded);
}));

test('on Windows the tools are the .exe and .cmd files of their names', () => {
  const dirs = new Set(['C:\\node\\node.exe', 'C:\\npm\\pi.cmd', 'C:\\Git\\cmd\\git.exe']);
  const fs = { exists: (path: string) => dirs.has(path), real: (path: string) => path };
  const host = testHost({ os: 'win32', env: { Path: 'C:\\nowhere;C:\\node;C:\\npm;C:\\Git\\cmd' } });
  assert.deepEqual(findServiceTools(host, fs), [{ tool: 'node', dir: 'C:\\node' }, { tool: 'pi', dir: 'C:\\npm' }, { tool: 'git', dir: 'C:\\Git\\cmd' }]);
});
