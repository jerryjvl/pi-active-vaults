// Documented behaviour: mcp.md — each profile is served on an endpoint, or
// over standard input/output for the process that started it; profiles on one
// address and port share it, chosen by path, with an optional default. An HTTP
// profile requires its bearer token (there is no anonymous access); a socket
// endpoint is protected by being accessible only to the user. A client sees
// exactly its profile's tools and calls them as on every other surface. The
// MCP adapter is thin: what a client may see and do is the core's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { mcpTools } from '../../src/core/operations/index.ts';
import { MCP_PATH, serveMcpStdio, startMcpEndpoint } from '../../src/mcp/index.ts';
import { INITIALIZE, post, stdioClient } from '../support/mcp-client.ts';
import { withInstallation, type TestInstallation } from '../support/installation.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'Unix domain sockets in tests' : false };
const TOKEN = 'chat-token-0123456789';

const CONFIG = [
  'mcp:',
  '  profiles:',
  '    - { name: chat, listen: "127.0.0.1:8735", token: "${MCP_CHAT}", permissions: ["@read"] }',
  '    - { name: local, permissions: ["status", "contract"] }',
].join('\n');

function profile(t: TestInstallation, name: string) {
  const found = t.installation.mcp.profiles.find((p) => p.name === name);
  assert.ok(found !== undefined);
  return found;
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('an HTTP endpoint answers only with its bearer token; with it, a client sees the profile\'s tools and calls them', withInstallation(async (t) => {
  const started = await startMcpEndpoint(t.context, [profile(t, 'chat')], { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 0 } });
  assert.ok(started.ok, JSON.stringify(!started.ok && started.error));
  const endpoint = { address: started.value.served[0]?.address ?? '', close: () => started.value.close() };
  try {
    assert.deepEqual(started.value.served.map((s) => s.profile), ['chat']);
    assert.match(endpoint.address, new RegExp(`^http://127\\.0\\.0\\.1:\\d+${MCP_PATH}$`));
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Basic ${TOKEN}` }]) {
      const refused = await post(endpoint.address, INITIALIZE, headers);
      assert.equal(refused.status, 401, JSON.stringify(headers));
      assert.ok(!refused.text.includes(TOKEN));
    }
    const auth = { authorization: `Bearer ${TOKEN}` };
    const init = await post(endpoint.address, INITIALIZE, auth);
    assert.equal(init.status, 200, init.text);
    assert.deepEqual((init.messages[0]?.['result'] as { serverInfo: { name: string } }).serverInfo.name, 'pi-active-vaults');

    const listed = await post(endpoint.address, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, auth);
    const names = (listed.messages[0]?.['result'] as { tools: { name: string }[] }).tools.map((x) => x.name);
    assert.deepEqual(names, mcpTools(profile(t, 'chat')).map((x) => x.name));

    const status = await post(endpoint.address, call(2, 'vault_status'), auth);
    const result = status.messages[0]?.['result'] as { content: { text: string }[]; structuredContent: { status: string }; isError: boolean };
    assert.equal(result.isError, false, status.text);
    assert.equal(result.structuredContent.status, 'ok');
    assert.match(result.content[0]?.text ?? '', /home/);

    const notListed = await post(endpoint.address, call(3, 'vault_write', { path: 'home:x.md', content: 'x', actor: 'gardener' }), auth);
    assert.match(notListed.text, /No tool|not found/);

    assert.equal((await post(endpoint.address.replace(MCP_PATH, '/other'), INITIALIZE, auth)).status, 404);
    assert.equal((await post(endpoint.address, undefined, auth, 'x'.repeat(5 * 1024 * 1024))).status, 413, 'a body past the bound is refused unread');
  } finally {
    await endpoint.close();
  }
}, { config: CONFIG, env: { MCP_CHAT: TOKEN } }));

test('an endpoint whose token cannot be resolved does not start', withInstallation(async (t) => {
  const started = await startMcpEndpoint(t.context, [profile(t, 'chat')], { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 0 } });
  assert.deepEqual(!started.ok && started.error.reason, 'token');
}, { config: CONFIG }));

const SHARED_TOKEN = 'shared-token-0123456789';
const SEPARATE_TOKEN = 'separate-token-0123456789';
const SHARED = [
  'mcp:',
  '  profiles:',
  '    - { name: assistant, listen: "127.0.0.1:8735", token: "${MCP_SHARED}", default: true, permissions: [status] }',
  '    - { name: assistant-alice, listen: "127.0.0.1:8735", token: "${MCP_SHARED}", permissions: [status, contract] }',
  '    - { name: separate, listen: "127.0.0.1:8735", token: "${MCP_SEPARATE}", permissions: [search] }',
  '    - { name: alone-a, listen: "127.0.0.1:8736", token: "${MCP_SHARED}", permissions: [status] }',
  '    - { name: alone-b, listen: "127.0.0.1:8736", token: "${MCP_SHARED}", permissions: [contract] }',
].join('\n');

async function toolsAt(url: string, token: string): Promise<{ status: number; names: string[] }> {
  const listed = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { authorization: `Bearer ${token}` });
  const names = listed.status === 200 ? (listed.messages[0]?.['result'] as { tools: { name: string }[] }).tools.map((x) => x.name) : [];
  return { status: listed.status, names };
}

test('profiles sharing an endpoint are chosen by path; the default serves /mcp and every name the endpoint does not have', withInstallation(async (t) => {
  const profiles = ['assistant', 'assistant-alice', 'separate'].map((name) => profile(t, name));
  const started = await startMcpEndpoint(t.context, profiles, { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 0 } });
  assert.ok(started.ok, JSON.stringify(!started.ok && started.error));
  try {
    const base = (started.value.served[0]?.address ?? '').replace(/\/mcp\/assistant$/, '');
    assert.deepEqual(started.value.served, profiles.map((p) => ({ profile: p.name, address: `${base}${MCP_PATH}/${p.name}` })));
    const assistant = mcpTools(profile(t, 'assistant')).map((x) => x.name);
    const alice = mcpTools(profile(t, 'assistant-alice')).map((x) => x.name);
    assert.notDeepEqual(assistant, alice);

    assert.deepEqual(await toolsAt(`${base}${MCP_PATH}/assistant-alice`, SHARED_TOKEN), { status: 200, names: alice });
    for (const path of ['', '/', '/assistant', '/bob', '/%7B%7BLIBRECHAT_USER_USERNAME%7D%7D']) {
      assert.deepEqual(await toolsAt(`${base}${MCP_PATH}${path}`, SHARED_TOKEN), { status: 200, names: assistant }, path);
    }
    assert.equal((await toolsAt(`${base}${MCP_PATH}/assistant-alice/more`, SHARED_TOKEN)).status, 404, 'a path deeper than a name is no profile\'s');

    assert.equal((await toolsAt(`${base}${MCP_PATH}/separate`, SHARED_TOKEN)).status, 401, 'each request is checked against its profile\'s own token');
    assert.equal((await toolsAt(`${base}${MCP_PATH}/separate`, SEPARATE_TOKEN)).status, 200);
    assert.equal((await toolsAt(`${base}${MCP_PATH}/assistant-alice`, SEPARATE_TOKEN)).status, 401);
    assert.equal((await toolsAt(`${base}${MCP_PATH}/bob`, SEPARATE_TOKEN)).status, 401, 'an unknown name is the default\'s, token and all');
  } finally {
    await started.value.close();
  }
}, { config: SHARED, env: { MCP_SHARED: SHARED_TOKEN, MCP_SEPARATE: SEPARATE_TOKEN } }));

test('without a default, a shared endpoint does not serve /mcp or a name it does not have', withInstallation(async (t) => {
  const started = await startMcpEndpoint(t.context, [profile(t, 'alone-a'), profile(t, 'alone-b')], { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 0 } });
  assert.ok(started.ok, JSON.stringify(!started.ok && started.error));
  try {
    const base = (started.value.served[0]?.address ?? '').replace(/\/mcp\/alone-a$/, '');
    assert.equal((await toolsAt(`${base}${MCP_PATH}/alone-b`, SHARED_TOKEN)).status, 200);
    for (const path of ['', '/bob']) assert.equal((await toolsAt(`${base}${MCP_PATH}${path}`, SHARED_TOKEN)).status, 404, path);
  } finally {
    await started.value.close();
  }
}, { config: SHARED, env: { MCP_SHARED: SHARED_TOKEN, MCP_SEPARATE: SEPARATE_TOKEN } }));

test('a shared endpoint whose profiles\' tokens cannot all be resolved does not start', withInstallation(async (t) => {
  const started = await startMcpEndpoint(t.context, ['assistant', 'separate'].map((name) => profile(t, name)), { endpoint: { kind: 'tcp', host: '127.0.0.1', port: 0 } });
  assert.deepEqual(!started.ok && started.error, { reason: 'token', where: 'mcp.profiles[2].token' });
}, { config: SHARED, env: { MCP_SHARED: SHARED_TOKEN } }));

test('a socket endpoint is the user\'s alone and needs no token', posixOnly, withInstallation(async (t) => {
  const path = t.dir.file('state', 'mcp-local.sock');
  const started = await startMcpEndpoint(t.context, [profile(t, 'local')], { endpoint: { kind: 'path', path } });
  assert.ok(started.ok, JSON.stringify(!started.ok && started.error));
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const init = await post({ socketPath: path }, INITIALIZE);
    assert.equal(init.status, 200, init.text);
    const contract = await post({ socketPath: path }, call(1, 'vault_contract', { vault: 'home', path: 'notes' }));
    assert.equal((contract.messages[0]?.['result'] as { isError: boolean }).isError, false, contract.text);
  } finally {
    await started.value.close();
  }
}, { config: CONFIG }));

test('over standard input/output, the profile is served to the process that started it', withInstallation(async (t) => {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const served = serveMcpStdio(t.context, profile(t, 'local'), { input: toServer, output: fromServer });
  try {
    const client = stdioClient(toServer, fromServer);
    const init = await client.request('initialize', INITIALIZE.params);
    assert.equal((init['result'] as { serverInfo: { name: string } }).serverInfo.name, 'pi-active-vaults');
    client.notify('notifications/initialized');
    const listed = await client.request('tools/list');
    assert.deepEqual((listed['result'] as { tools: { name: string }[] }).tools.map((x) => x.name), ['vault_contract', 'vault_status']);
    const status = await client.request('tools/call', { name: 'vault_status', arguments: {} });
    assert.equal((status['result'] as { isError: boolean }).isError, false, JSON.stringify(status));
  } finally {
    await served.close();
  }
}, { config: CONFIG }));
