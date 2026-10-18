// End to end (implementation plan, Stage 7): an MCP read-only profile
// (mcp.md). The daemon serves it over HTTP with its bearer token, and
// `vault mcp` serves it over standard input/output; both offer exactly the
// `@read` operations, nothing for a vault the profile is given none for —
// refused exactly as a vault that does not exist — and no way to change
// anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { cliFor, freePort } from '../support/cli.ts';
import { fakePi, withDaemon } from '../support/daemon.ts';
import { withInstallation } from '../support/installation.ts';
import { INITIALIZE, post, stdioClient } from '../support/mcp-client.ts';
import { RUNNING } from '../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'the daemon\'s Unix domain socket in tests' : false };
const TOKEN = 'reader-secret';
const READ_TOOLS = ['vault_contract', 'vault_jobs', 'vault_read', 'vault_search', 'vault_status', 'vault_trace'];

type ToolResult = { content: { text: string }[]; isError: boolean };
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('a read-only profile lists and answers only reads, hides a vault it is given nothing for, and changes nothing', posixOnly, async () => {
  const port = await freePort();
  const config = [
    'mcp:',
    '  profiles:',
    '    - name: reader',
    `      listen: "127.0.0.1:${port}"`,
    '      token: "${MCP_READER}"',
    '      permissions: ["@read"]',
    '      vaults: { private: [] }',
  ].join('\n');
  await withInstallation(async (t) => {
    t.repo.write('notes/a.md', '# A\n\nAbout apples.\n');
    t.accept(t.repo.commit('A note'));
    const secret = t.others['private'];
    assert.ok(secret !== undefined);
    secret.repo.write('notes/p.md', '# Private\n');
    const before = [t.repo.git('rev-parse', 'main'), secret.repo.git('rev-parse', 'main')];

    await withDaemon(t, fakePi(t), async (daemon) => {
      const url = `http://127.0.0.1:${port}/mcp`;
      assert.deepEqual(daemon.endpoints.map((e) => [e.profile, 'address' in e ? e.address : e.error.reason]), [['reader', url]]);
      assert.equal((await post(url, INITIALIZE)).status, 401, 'no token, no answer');
      assert.equal((await post(url, INITIALIZE, { authorization: 'Bearer guess' })).status, 401);
      const auth = { authorization: `Bearer ${TOKEN}` };
      assert.equal((await post(url, INITIALIZE, auth)).status, 200);
      const rpc = async (message: object): Promise<Record<string, unknown>> => {
        const answer = await post(url, message, auth);
        return answer.messages[0] ?? {};
      };

      const listed = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))['result'] as { tools: { name: string }[] };
      assert.deepEqual(listed.tools.map((x) => x.name).sort(), READ_TOOLS, 'exactly @read');

      const read = (await rpc(call(2, 'vault_read', { path: 'home:notes/a.md' })))['result'] as ToolResult;
      assert.equal(read.isError, false, JSON.stringify(read));
      assert.match(read.content[0]?.text ?? '', /About apples/);

      const hidden = (await rpc(call(3, 'vault_read', { path: 'private:notes/p.md' })))['result'] as ToolResult;
      const absent = (await rpc(call(4, 'vault_read', { path: 'nowhere:notes/p.md' })))['result'] as ToolResult;
      assert.equal(hidden.isError, true);
      assert.equal(hidden.content[0]?.text, absent.content[0]?.text?.replace('nowhere', 'private'), 'refused as if it did not exist');

      const status = (await rpc(call(5, 'vault_status')))['result'] as ToolResult;
      assert.match(status.content[0]?.text ?? '', /^home: /m);
      assert.doesNotMatch(status.content[0]?.text ?? '', /private/, 'a vault it may not touch is not mentioned');

      for (const [id, name, args] of [
        [6, 'vault_write', { path: 'home:notes/b.md', content: 'x', actor: 'gardener' }],
        [7, 'vault_trigger', { vault: 'home', name: 'go' }],
        [8, 'vault_accept', { vault: 'home', adopt: before[0] }],
      ] as const) {
        const answer = await post(url, call(id, name, args), auth);
        assert.match(answer.text, /No tool|not found/, `${name} does not exist for this profile`);
      }
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const serving = cliFor(t, { stdio: { input, output } })('mcp', '--profile', 'reader');
    const client = stdioClient(input, output);
    await client.request('initialize', INITIALIZE.params);
    client.notify('notifications/initialized');
    const overStdio = (await client.request('tools/list'))['result'] as { tools: { name: string }[] };
    assert.deepEqual(overStdio.tools.map((x) => x.name).sort(), READ_TOOLS, 'the same profile over standard input/output');
    input.end();
    assert.equal((await serving).code, 0);

    assert.deepEqual([t.repo.git('rev-parse', 'main'), secret.repo.git('rev-parse', 'main')], before, 'nothing changed');
    assert.equal(t.repo.git('branch', '--list', 'actor/*'), '', 'not even an actor branch');
  }, { running: RUNNING, config, env: { MCP_READER: TOKEN }, others: [{ id: 'private' }] })();
});
