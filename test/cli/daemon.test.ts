// Documented behaviour: cli.md "Daemon" — `vault daemon install` writes the
// platform's user-service definition, `start` / `stop` / `status` control
// it, `run` runs it in the foreground, `print-unit` prints the definition;
// commands that need the daemon say so and exit 1. daemon.md "Single
// instance" — a second daemon does not run. "Service installation" — install
// records the directories in which node, pi and git were found on PATH, as
// found, and gives the service that PATH; `vault doctor` warns when a recorded
// directory no longer holds its tool, and installing again records the current
// ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_PROGRAM } from '../../src/cli/program.ts';
import type { CliIo } from '../../src/cli/run.ts';
import { recordedServiceTools } from '../../src/core/queue/index.ts';
import { requestOverSocket } from '../../src/core/socket/index.ts';
import { cliFor } from '../support/cli.ts';
import { fakePi } from '../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../support/installation.ts';
import { ME, OTHER, RUNNING } from '../support/session.ts';

const linuxOnly = { skip: process.platform !== 'linux' ? 'the systemd unit' : false };

/** The CLI with its service manager recorded rather than run, and the service definition written under the test's directory. */
function cli(t: TestInstallation, extra: Partial<CliIo> = {}) {
  const ran: string[][] = [];
  const run = cliFor(t, {
    io: {
      host: { ...t.host, env: { ...t.host.env, XDG_CONFIG_HOME: t.dir.file('xdg') } },
      runProgram: async (program) => {
        ran.push([program.file, ...program.args]);
        return 0;
      },
      ...extra,
    },
  });
  return { run, ran };
}

test('print-unit prints the platform\'s service definition, which runs this CLI', linuxOnly, withInstallation(async (t) => {
  const printed = await cli(t).run('daemon', 'print-unit');
  assert.equal(printed.code, 0);
  assert.match(printed.stdout, /^\[Service\]$/m);
  assert.ok(printed.stdout.includes(CLI_PROGRAM.replaceAll('$', '$$$$')), printed.stdout);
}));

test('on a headless Mac, print-unit --headless prints the launchd daemon, which is installed with privileges; elsewhere --headless is a usage error', withInstallation(async (t) => {
  const mac = cli(t, { host: { ...t.host, os: 'darwin', user: 'alice' } });
  const printed = await mac.run('daemon', 'print-unit', '--headless');
  assert.equal(printed.code, 0, printed.stderr);
  assert.match(printed.stdout, /<key>UserName<\/key>\s*<string>alice<\/string>/);
  const install = await mac.run('daemon', 'install', '--headless');
  assert.equal(install.code, 2, 'the package never installs into the system domain itself');
  assert.match(install.stderr, /sudo tee \/Library\/LaunchDaemons\/pi-active-vaults\.daemon\.plist/);
  assert.match(install.stderr, /sudo \/bin\/launchctl bootstrap system \/Library\/LaunchDaemons\/pi-active-vaults\.daemon\.plist/);
  assert.deepEqual(mac.ran, []);
  const linux = await cli(t, { host: { ...t.host, os: 'linux' } }).run('daemon', 'print-unit', '--headless');
  assert.equal(linux.code, 2);
  assert.match(linux.stderr, /--headless is for macOS/);
  assert.equal((await cli(t).run('daemon', 'start', '--frobnicate')).code, 2);
}));

test('install writes the definition and registers it; start and stop run the service manager', linuxOnly, withInstallation(async (t) => {
  const { run, ran } = cli(t);
  const installed = await run('daemon', 'install');
  assert.equal(installed.code, 0, installed.stderr);
  const unit = join(t.dir.file('xdg'), 'systemd', 'user', 'pi-active-vaults.service');
  assert.ok(existsSync(unit));
  assert.match(readFileSync(unit, 'utf8'), /^ExecStart=/m);
  assert.equal((await run('daemon', 'start')).code, 0);
  assert.equal((await run('daemon', 'stop')).code, 0);
  assert.deepEqual(ran.map((r) => r.slice(1).join(' ')), [
    '--user daemon-reload', '--user enable pi-active-vaults.service', '--user start pi-active-vaults.service', '--user stop pi-active-vaults.service',
  ]);
}));

/** An executable file `name` in a new directory `dir`. */
function makeTool(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '#!/bin/sh\n');
  chmodSync(join(dir, name), 0o755);
}

test('install records where node, pi and git are on PATH and gives the unit that PATH; doctor warns when one is gone, and installing again fixes it', linuxOnly, withInstallation(async (t) => {
  const tools = t.dir.file('tools');
  makeTool(join(tools, 'node', 'latest', 'bin'), 'node');
  makeTool(join(tools, 'pi', 'bin'), 'pi');
  makeTool(join(tools, 'git', 'bin'), 'git');
  const path = ['node/latest/bin', 'pi/bin', 'git/bin'].map((d) => join(tools, d)).join(':');
  const host = { ...t.host, env: { ...t.host.env, XDG_CONFIG_HOME: t.dir.file('xdg'), PATH: path } };
  const { run } = cli(t, { host });
  const recorded = () => recordedServiceTools(t.context.state).map((r) => [r.tool, r.dir]);

  assert.equal((await run('daemon', 'print-unit')).code, 0);
  assert.deepEqual(recorded(), [], 'printing a definition records nothing');
  assert.equal((await run('daemon', 'install')).code, 0);
  assert.deepEqual(recorded(), [['git', join(tools, 'git', 'bin')], ['node', join(tools, 'node', 'latest', 'bin')], ['pi', join(tools, 'pi', 'bin')]]);
  const unit = readFileSync(join(t.dir.file('xdg'), 'systemd', 'user', 'pi-active-vaults.service'), 'utf8');
  assert.ok(unit.includes(`Environment="PATH=${path}:/usr/local/sbin:`), unit);

  const serviceLines = async () => (await run('doctor')).stdout.split('\n').filter((l) => /service:/.test(l));
  assert.deepEqual(await serviceLines(), []);
  rmSync(join(tools, 'pi', 'bin', 'pi'));
  const warned = await serviceLines();
  assert.equal(warned.length, 1);
  assert.match(warned[0] ?? '', /^warning service: .*\bpi\b.* no longer /);
  assert.ok((warned[0] ?? '').includes(join(tools, 'pi', 'bin')) && (warned[0] ?? '').includes('"vault daemon install"'), warned[0]);

  makeTool(join(tools, 'pi', 'v2', 'bin'), 'pi');
  const moved = { ...host, env: { ...host.env, PATH: path.replace(join(tools, 'pi', 'bin'), join(tools, 'pi', 'v2', 'bin')) } };
  assert.equal((await cli(t, { host: moved }).run('daemon', 'install')).code, 0);
  assert.deepEqual(recorded().find(([tool]) => tool === 'pi'), ['pi', join(tools, 'pi', 'v2', 'bin')]);
  assert.deepEqual(await serviceLines(), [], 'installing again records the current ones');
}));

test('run runs the daemon until it is stopped; meanwhile status reports it and a second run does not start', withInstallation(async (t) => {
  let stop = (): void => {};
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const pi = fakePi(t);
  const { run } = cli(t, { until: stopped, daemon: { pid: ME, pi: pi.options.pi } });
  const running = run('daemon', 'run');
  for (let i = 0; i < 200 && !(await requestOverSocket(t.installation.paths.socket, 'ping', {})).ok; i++) await new Promise((r) => setTimeout(r, 10));
  const status = await run('daemon', 'status');
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /The daemon runs: 0 queued, 0 running/);
  const second = await cli(t, { until: Promise.resolve(), daemon: { pid: OTHER, pi: pi.options.pi } }).run('daemon', 'run');
  assert.equal(second.code, 0);
  assert.match(second.stderr, /already runs \(process 4242\)/);
  stop();
  assert.equal((await running).code, 0);
}, { running: RUNNING }));
