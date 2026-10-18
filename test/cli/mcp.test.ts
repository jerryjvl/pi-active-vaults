// Documented behaviour: cli.md — `vault mcp --profile <name>` serves one MCP
// profile over standard input/output, for local MCP clients that start their
// own servers; mcp.md — standard-I/O servers trust the process that started
// them, and any number can run alongside the daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { cliFor } from '../support/cli.ts';
import { INITIALIZE, stdioClient } from '../support/mcp-client.ts';
import { withInstallation } from '../support/installation.ts';

const CONFIG = 'mcp:\n  profiles:\n    - { name: local, permissions: [status, contract] }';

test('vault mcp --profile serves that profile over standard input/output until its input ends', withInstallation(async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const running = cliFor(t, { stdio: { input, output } })('mcp', '--profile', 'local');
  const client = stdioClient(input, output);
  const init = await client.request('initialize', INITIALIZE.params);
  assert.ok(init['result'] !== undefined, JSON.stringify(init));
  client.notify('notifications/initialized');
  const listed = await client.request('tools/list');
  assert.deepEqual((listed['result'] as { tools: { name: string }[] }).tools.map((x) => x.name), ['vault_contract', 'vault_status']);
  input.end();
  assert.equal((await running).code, 0);
}, { config: CONFIG }));

test('vault mcp needs a configured profile: none named, an unknown one, or anything else is a usage error', withInstallation(async (t) => {
  for (const argv of [['mcp'], ['mcp', '--profile', 'nobody'], ['mcp', '--profile'], ['mcp', '--profile', 'local', 'extra']]) {
    const ran = await cliFor(t, { stdio: { input: new PassThrough(), output: new PassThrough() } })(...argv);
    assert.equal(ran.code, 2, argv.join(' '));
    assert.match(ran.stderr, /profile/, argv.join(' '));
  }
}, { config: CONFIG }));
