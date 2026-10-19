// Documented behaviour: concepts.md "Session tree" (fan-out and gather) and
// api.md `vault_fan_out` — a list of items, an instruction for each, and an
// optional instruction to combine the results. Each item is a session of its
// own that can read (Pi's read-only file tools, vault_read, vault_search) and
// use the MCP servers the call names, but cannot write; the session that
// fanned out writes what comes back. A failed item is reported, never
// gathered; without a gather instruction the outcomes come back as JSON. The
// items' tool calls taint the session like its own, and their work counts
// against the session's budget: a headless run that has used its budget fans
// out no further. Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, getCurrentTools, type FauxResponseStep, type JsonObject } from '@earendil-works/pi-ai';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRunContext } from '../../src/core/sessions/index.ts';
import { withInstallation } from '../support/installation.ts';
import { DONE, toolCall, toolResults, withPi } from '../support/pi.ts';
import { RUNNING, runOf, startedSpawn } from '../support/session.ts';
import { withStubServer, type StubHandler } from '../support/stub-server.ts';

const fanOut = (args: JsonObject) => toolCall('vault_fan_out', args);

interface Asked { prompt: string; tools: string[] }

/** A model step that records what it was asked and which tools it was offered, then answers with `reply`. */
function recording(asked: Asked[], reply: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
  return (context) => {
    const last = context.messages.at(-1) as { content: unknown };
    asked.push({ prompt: typeof last.content === 'string' ? last.content : JSON.stringify(last.content), tools: getCurrentTools(context.messages).map((t) => t.name).sort() });
    return reply;
  };
}

const structuredOf = (pi: { results: { tool: string; structured: unknown }[] }) =>
  pi.results.find((r) => r.tool === 'vault_fan_out')?.structured as { status: string; data: { gathered: string | null; items: { item: string; outcome: string; result?: string; reason?: string }[] } } | undefined;

/** A streamable-HTTP MCP server with one tool, `web_search`, that records its calls. */
function webServer(calls: unknown[]): StubHandler {
  return (request) => {
    if (request.method !== 'POST') return { status: 405 };
    const message = JSON.parse(request.body) as { id?: number; method: string; params?: { protocolVersion?: string; arguments?: unknown } };
    if (message.id === undefined) return { status: 202 };
    const reply = (result: object) => ({ body: { jsonrpc: '2.0', id: message.id, result } });
    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'web', version: '1.0.0' } });
      case 'tools/list':
        return reply({ tools: [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] });
      case 'tools/call':
        calls.push(message.params?.arguments);
        return reply({ content: [{ type: 'text', text: 'Apples are red (https://example.org/apples).' }] });
      default:
        return { body: { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } } };
    }
  };
}

test('each item is a session of its own that can read but not write; the results are gathered', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const asked: Asked[] = [];
    pi.respond(
      fanOut({ items: ['apples', 'pears'], each: 'Say the colour of the item.', gather: 'List the colours.' }),
      recording(asked, fauxAssistantMessage('red')), recording(asked, fauxAssistantMessage('green')), recording(asked, fauxAssistantMessage('red, green')),
      DONE,
    );
    await pi.prompt('Fan out.');
    assert.equal(asked.length, 3);
    assert.match(asked[0]?.prompt ?? '', /Say the colour of the item\.[^]*apples/);
    assert.match(asked[1]?.prompt ?? '', /pears/);
    assert.match(asked[2]?.prompt ?? '', /List the colours\.[^]*apples[^]*red[^]*pears[^]*green/);
    const reading = ['find', 'grep', 'ls', 'read', 'vault_read', 'vault_search'];
    assert.deepEqual(asked[0]?.tools, reading, 'an item can look, not write');
    assert.deepEqual(asked[1]?.tools, reading);
    assert.deepEqual(asked[2]?.tools, [], 'the gather is a plain request');
    assert.match(toolResults(pi.requests.at(-1), 'vault_fan_out')[0] ?? '', /red, green/);
    const structured = structuredOf(pi);
    assert.deepEqual(structured?.data.items.map((i) => [i.item, i.outcome, i.result]), [['apples', 'done', 'red'], ['pears', 'done', 'green']]);
    assert.equal(structured?.data.gathered, 'red, green');
  });
}, { running: RUNNING }));

test('an item can use its tools before it answers', withInstallation(async (t) => {
  writeFileSync(join(t.repo.path, 'notes.md'), 'Pears are green.');
  await withPi(t, {}, async (pi) => {
    const asked: Asked[] = [];
    pi.respond(
      fanOut({ items: ['pears'], each: 'Look up the colour of the item in notes.md.' }),
      toolCall('read', { path: 'notes.md' }), recording(asked, fauxAssistantMessage('green')),
      DONE,
    );
    await pi.prompt('Fan out.');
    assert.match(asked[0]?.prompt ?? '', /Pears are green/, 'the item saw its tool result');
    assert.deepEqual(structuredOf(pi)?.data.items.map((i) => [i.item, i.outcome, i.result]), [['pears', 'done', 'green']]);
  });
}, { running: RUNNING }));

test('an item that fails is reported as failed and not gathered; the others still are', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const asked: Asked[] = [];
    pi.respond(
      fanOut({ items: ['a', 'b'], each: 'Do it.', gather: 'Combine.' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }), fauxAssistantMessage('B'), recording(asked, fauxAssistantMessage('only B')),
      DONE,
    );
    await pi.prompt('Fan out.');
    assert.deepEqual(structuredOf(pi)?.data.items.map((i) => [i.item, i.outcome, i.reason]), [['a', 'failed', 'overloaded'], ['b', 'done', undefined]]);
    assert.doesNotMatch(asked[0]?.prompt ?? '', /item="a"/, 'the failed item is not gathered');
    assert.match(toolResults(pi.requests.at(-1), 'vault_fan_out')[0] ?? '', /Not done:\na: failed \(overloaded\)/);
  });
}, { running: RUNNING }));

test('without a gather instruction each item\'s outcome comes back as it is, as JSON', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    pi.respond(
      fanOut({ items: ['a', 'b'], each: 'Do it.' }),
      fauxAssistantMessage('{"slug":"a"}'), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }),
      DONE,
    );
    await pi.prompt('Fan out.');
    const text = toolResults(pi.requests.at(-1), 'vault_fan_out')[0] ?? '';
    assert.deepEqual(JSON.parse(text), [{ item: 'a', outcome: 'done', result: '{"slug":"a"}' }, { item: 'b', outcome: 'failed', reason: 'overloaded' }]);
    assert.equal(structuredOf(pi)?.data.gathered, null);
  });
}, { running: RUNNING }));

test('items get the tools of the MCP servers the call names, and using them taints the session', { skip: process.platform === 'win32' ? 'bash' : false }, withInstallation(async (t) => {
  const calls: unknown[] = [];
  await withStubServer(webServer(calls), async (url) => {
    await withPi(t, { flags: { 'vault-actor': 'gardener' }, mcpServers: { web: { url: `${url}/mcp` } } }, async (pi) => {
      const asked: Asked[] = [];
      pi.respond(
        fanOut({ items: ['apples'], each: 'Search for the colour of the item.', mcp: ['web'] }),
        recording(asked, toolCall('mcp__web__web_search', { query: 'apple colour' })), recording(asked, fauxAssistantMessage('red')),
        toolCall('write', { path: join(t.vault.worktrees, 'gardener', 'a.md'), content: 'Apples are red.' }),
        toolCall('vault_commit', { message: 'From the fan-out' }),
        DONE,
      );
      await pi.prompt('Fan out.');
      assert.ok(asked[0]?.tools.includes('mcp__web__web_search'), `offered: ${asked[0]?.tools.join(', ')}`);
      assert.deepEqual(calls, [{ query: 'apple colour' }]);
      assert.match(asked[1]?.prompt ?? '', /Apples are red/);
      assert.deepEqual(structuredOf(pi)?.data.items.map((i) => [i.outcome, i.result]), [['done', 'red']]);
      assert.match(t.repo.git('log', '-1', '--format=%B', 'refs/heads/actor/gardener'), /Vault-Tainted: yes/, 'what the item read taints what the session writes');
    });
  });
}, { running: RUNNING }));

test('an MCP server that is not in Pi\'s mcp.json is a request the model should fix; no item runs', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    pi.respond(fanOut({ items: ['a'], each: 'Do it.', mcp: ['web'] }), DONE);
    await pi.prompt('Fan out.');
    const result = pi.results.find((r) => r.tool === 'vault_fan_out');
    assert.equal(result?.isError, true);
    assert.match(result?.text ?? '', /No MCP server named web in .*mcp\.json/);
    assert.equal(pi.requests.length, 2, 'only the session\'s own requests');
  });
}, { running: RUNNING }));

test('no items is a request the model should fix', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    pi.respond(fanOut({ items: [], each: 'Do it.', gather: 'Combine.' }), DONE);
    await pi.prompt('Fan out.');
    assert.equal(pi.results.find((r) => r.tool === 'vault_fan_out')?.isError, true);
  });
}, { running: RUNNING }));

test('a headless run fans out no further once its budget is used', withInstallation(async (t) => {
  const entry = startedSpawn(t, 'jobs/daily.md', 50);
  const runFile = t.dir.file('run.json');
  writeFileSync(runFile, renderRunContext(runOf(entry)));
  await withPi(t, { flags: { 'vault-run': runFile } }, async (pi) => {
    pi.respond(fanOut({ items: ['a', 'b', 'c'], each: 'Do it.', gather: 'Combine.' }), fauxAssistantMessage('A'), fauxAssistantMessage('only A'), DONE);
    await pi.prompt('Run the job.');
    assert.deepEqual(structuredOf(pi)?.data.items.map((i) => [i.item, i.outcome]), [['a', 'done'], ['b', 'skipped'], ['c', 'skipped']]);
  });
}, { running: RUNNING }));

test('an item over the budget stops before its next step, and later items are skipped', withInstallation(async (t) => {
  const entry = startedSpawn(t, 'jobs/daily.md', 50);
  const runFile = t.dir.file('run.json');
  writeFileSync(runFile, renderRunContext(runOf(entry)));
  await withPi(t, { flags: { 'vault-run': runFile } }, async (pi) => {
    pi.respond(fanOut({ items: ['a', 'b'], each: 'Do it.' }), toolCall('read', { path: 'notes.md' }), DONE);
    await pi.prompt('Run the job.');
    const result = pi.results.find((r) => r.tool === 'vault_fan_out');
    assert.equal(result?.isError, true);
    assert.match(result?.text ?? '', /a: the run's budget is used; b: the run's budget is used/);
  });
}, { running: RUNNING }));
