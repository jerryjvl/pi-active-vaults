// Documented behaviour: concepts.md "Session tree" (fan-out and gather) and
// api.md `vault_fan_out` — a list of items, an instruction for each, and an
// optional instruction to combine the results. Each item is a session of its
// own that can read (Pi's read-only file tools, vault_read, vault_search) and
// use the MCP servers the call names, but cannot write; the session that
// fanned out writes what comes back. A failed item is reported, never
// gathered; without a gather instruction the outcomes come back as JSON. The
// items may come from a scratch file (a JSON array of strings a script wrote). The
// items' tool calls taint the session like its own, and their work counts
// against the session's budget: a headless run that has used its budget fans
// out no further. Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools, type FauxResponseStep, type JsonObject } from '@earendil-works/pi-ai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRunContext } from '../../src/core/sessions/index.ts';
import { readFullLog } from '../../src/core/traces/index.ts';
import { withInstallation } from '../support/installation.ts';
import { DONE, toolCall, toolResults, withPi } from '../support/pi.ts';
import { RUNNING, runOf, startedSpawn } from '../support/session.ts';
import { withStubServer, type StubHandler } from '../support/stub-server.ts';

const fanOut = (args: JsonObject) => toolCall('vault_fan_out', args);

interface Asked { prompt: string; tools: string[]; system: string }

/** A model step that records what it was asked and which tools it was offered, then answers with `reply`. */
function recording(asked: Asked[], reply: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep {
  return (context) => {
    const last = context.messages.at(-1) as { content: unknown };
    asked.push({ prompt: typeof last.content === 'string' ? last.content : JSON.stringify(last.content), tools: getCurrentTools(context.messages).map((t) => t.name).sort(), system: getCurrentSystemPrompt(context.messages) });
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

test('an item\'s tool called under a prefix reaches the tool it means', withInstallation(async (t) => {
  writeFileSync(join(t.repo.path, 'notes.md'), 'Pears are green.');
  await withPi(t, {}, async (pi) => {
    const asked: Asked[] = [];
    pi.respond(
      fanOut({ items: ['pears'], each: 'Look up the colour of the item in notes.md.' }),
      toolCall('tools.read', { path: 'notes.md' }), recording(asked, fauxAssistantMessage('green')),
      DONE,
    );
    await pi.prompt('Fan out.');
    assert.match(asked[0]?.prompt ?? '', /Pears are green/, 'the item saw its tool result, not "not found"');
  });
}, { running: RUNNING }));

test("an item gets the installation's own instructions after its item prompt — never a project's", withInstallation(async (t) => {
  // A vault's content could supply a project .pi/APPEND_SYSTEM.md; only the installation's own counts.
  const cwd = t.vault.path;
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT RULE');
  await withPi(t, { cwd, appendSystem: 'Never put data into a URL.' }, async (pi) => {
    const asked: Asked[] = [];
    pi.respond(fanOut({ items: ['apples'], each: 'Say the colour.' }), recording(asked, fauxAssistantMessage('red')), DONE);
    await pi.prompt('Fan out.');
    const system = asked[0]?.system ?? '';
    assert.match(system, /You do one piece of a larger task[^]*Never put data into a URL\./, system);
    assert.doesNotMatch(system, /PROJECT RULE/);
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

test('with save, the outcomes go to the session\'s scratch directory and only a summary comes back; the directory goes with the session', withInstallation(async (t) => {
  let scratch = '';
  await withPi(t, {}, async (pi) => {
    pi.respond(
      fanOut({ items: ['a', 'b'], each: 'Do it.', save: 'scratch:outcomes.json' }),
      fauxAssistantMessage('A'), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }),
      DONE,
    );
    await pi.prompt('Fan out.');
    const trace = (pi.events.find((e) => e.channel === 'pav:v1:ready')?.data as { trace: string }).trace;
    scratch = join(t.context.installation.paths.scratch, trace);
    assert.deepEqual(JSON.parse(readFileSync(join(scratch, 'outcomes.json'), 'utf8')), [{ item: 'a', outcome: 'done', result: 'A' }, { item: 'b', outcome: 'failed', reason: 'overloaded' }]);
    assert.equal(toolResults(pi.requests.at(-1), 'vault_fan_out')[0], 'Saved 2 outcome(s) to scratch:outcomes.json: 1 done.\nNot done:\nb: failed (overloaded)');
  });
  assert.equal(existsSync(scratch), false, 'removed when the session closed');
}, { running: RUNNING }));

test('save names a file in the scratch directory, never a path, and does not go with gather', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    pi.respond(fanOut({ items: ['a'], each: 'Do it.', save: 'scratch:../x.json' }), fanOut({ items: ['a'], each: 'Do it.', save: 'scratch:x.json', gather: 'Combine.' }), DONE);
    await pi.prompt('Fan out.');
    const results = pi.results.filter((r) => r.tool === 'vault_fan_out');
    assert.deepEqual(results.map((r) => r.isError), [true, true]);
    assert.match(results[0]?.text ?? '', /not a file in this session's scratch directory/);
  });
}, { running: RUNNING }));

test('items can come from a scratch file a script wrote, a JSON array of strings; a summary names a long item by its start', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const long = JSON.stringify({ letter: 'x'.repeat(200) });
    // The first model step stands in for a script: it writes the items to the session's scratch directory.
    const scriptThen = (step: ReturnType<typeof fanOut>): FauxResponseStep => () => {
      const trace = (pi.events.find((e) => e.channel === 'pav:v1:ready')?.data as { trace: string }).trace;
      const scratch = join(t.context.installation.paths.scratch, trace);
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'items.json'), JSON.stringify(['a', long]));
      return step;
    };
    pi.respond(
      scriptThen(fanOut({ items: 'scratch:items.json', each: 'Do it.', save: 'scratch:outcomes.json' })),
      fauxAssistantMessage('A'), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }),
      DONE,
    );
    await pi.prompt('Fan out.');
    assert.deepEqual(structuredOf(pi)?.data.items.map((i) => [i.item, i.outcome]), [['a', 'done'], [long, 'failed']]);
    assert.equal(toolResults(pi.requests.at(-1), 'vault_fan_out')[0], `Saved 2 outcome(s) to scratch:outcomes.json: 1 done.\nNot done:\n${long.slice(0, 77)}…: failed (overloaded)`);
  });
}, { running: RUNNING }));

test('items from scratch name a file there holding a JSON array of strings; anything else is a request the model should fix', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const scriptThen = (name: string, content: string, step: ReturnType<typeof fanOut>): FauxResponseStep => () => {
      const trace = (pi.events.find((e) => e.channel === 'pav:v1:ready')?.data as { trace: string }).trace;
      const scratch = join(t.context.installation.paths.scratch, trace);
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, name), content);
      return step;
    };
    pi.respond(
      fanOut({ items: 'scratch:../items.json', each: 'Do it.' }),
      fanOut({ items: 'scratch:missing.json', each: 'Do it.' }),
      scriptThen('numbers.json', '[1, 2]', fanOut({ items: 'scratch:numbers.json', each: 'Do it.' })),
      fanOut({ items: 'items.json', each: 'Do it.' }),
      DONE,
    );
    await pi.prompt('Fan out.');
    const results = pi.results.filter((r) => r.tool === 'vault_fan_out');
    assert.deepEqual(results.map((r) => r.isError), [true, true, true, true]);
    assert.match(results[0]?.text ?? '', /not a file in this session's scratch directory/);
    assert.match(results[1]?.text ?? '', /cannot be read as JSON/);
    assert.match(results[2]?.text ?? '', /must hold a JSON array of strings/);
    assert.match(results[3]?.text ?? '', /not a file in this session's scratch directory/);
    assert.equal(pi.requests.length, 5, 'no item ran');
  });
}, { running: RUNNING }));

/** The session's trace, as its ready event gives it. */
const traceOf = (pi: { events: { channel: string; data: unknown }[] }): string => (pi.events.find((e) => e.channel === 'pav:v1:ready')?.data as { trace: string }).trace;

test('with workspace, each item writes files in a new directory of its own and nowhere else; the outcomes say where, and an empty answer is no failure', { skip: process.platform === 'win32' ? 'paths' : false }, withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const asked: Asked[] = [];
    let first = '';
    const spaceOf = (n: number): string => join(t.context.installation.paths.scratch, traceOf(pi), first, String(n));
    pi.respond(
      fanOut({ items: ['apples', 'pears'], each: 'Write the colour to colour.json.', workspace: true, save: 'scratch:outcomes.json' }),
      // Item 1: a relative path lands in its workspace; then an attempt outside it, and on item 2's directory.
      (context) => {
        asked.push({ prompt: JSON.stringify((context.messages.at(-1) as { content: unknown }).content), tools: getCurrentTools(context.messages).map((x) => x.name).sort(), system: getCurrentSystemPrompt(context.messages) });
        return toolCall('workspace_write', { path: 'colour.json', content: '{"colour": "red"}' });
      },
      () => toolCall('workspace_write', { path: join(t.repo.path, 'escape.md'), content: 'x' }),
      recording(asked, toolCall('workspace_write', { path: '../2/colour.json', content: '{"colour": "blue"}' })),
      recording(asked, fauxAssistantMessage('')),
      // Item 2: JSON that does not parse is refused and told, then written again, corrected.
      () => toolCall('workspace_write', { path: 'colour.json', content: '{"colour": green}' }),
      recording(asked, toolCall('workspace_write', { path: 'colour.json', content: '{"colour": "green"}' })),
      fauxAssistantMessage('wrote colour.json'),
      DONE,
    );
    await pi.prompt('Fan out.');
    const items = structuredOf(pi)?.data.items as { item: string; outcome: string; result?: string; workspace?: string }[];
    first = (items[0]?.workspace ?? '').split('/')[0] ?? '';
    assert.match(first, /^fanout-[0-9A-Z]{26}$/, 'named by the package, from the trace IDs');
    assert.deepEqual(items.map((i) => [i.item, i.outcome, i.result, i.workspace]), [['apples', 'done', '', `${first}/1`], ['pears', 'done', 'wrote colour.json', `${first}/2`]]);
    assert.match(asked[0]?.prompt ?? '', new RegExp(`Your workspace, the one directory you can write in: ${spaceOf(1).replaceAll('/', '\\/')}`));
    assert.deepEqual(asked[0]?.tools, ['find', 'grep', 'ls', 'read', 'vault_read', 'vault_search', 'workspace_edit', 'workspace_write']);
    assert.match(asked[0]?.system ?? '', /write only in your workspace/);
    assert.match(asked[1]?.prompt ?? '', /outside your workspace/, 'a path outside is refused and told');
    assert.match(asked[2]?.prompt ?? '', /outside your workspace/, 'so is another item\'s directory');
    assert.match(asked[3]?.prompt ?? '', /would not be valid JSON/);
    assert.equal(readFileSync(join(spaceOf(1), 'colour.json'), 'utf8'), '{"colour": "red"}');
    assert.equal(readFileSync(join(spaceOf(2), 'colour.json'), 'utf8'), '{"colour": "green"}');
    assert.equal(existsSync(join(t.repo.path, 'escape.md')), false);
    assert.match(toolResults(pi.requests.at(-1), 'vault_fan_out')[0] ?? '', new RegExp(`The items' files are in scratch:${first}/<n>\\.`));
    // Every item's answer is in the session's log, beside its tool calls.
    const log = readFullLog(t.context.installation.paths.logs, traceOf(pi)).find((l) => l.name === 'session')?.text ?? '';
    const answers = log.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; item?: number; outcome?: string; text?: string; workspace?: string }).filter((l) => l.kind === 'item');
    assert.deepEqual(answers.map((a) => [a.item, a.outcome, a.text, a.workspace]), [[1, 'done', '', `${first}/1`], [2, 'done', 'wrote colour.json', `${first}/2`]]);
  });
}, { running: RUNNING }));

test('a workspace is seeded from a directory a script prepared, a copy per item; each fan-out gets a new one', { skip: process.platform === 'win32' ? 'paths' : false }, withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const asked: Asked[] = [];
    const scriptThen = (step: ReturnType<typeof fanOut>): FauxResponseStep => () => {
      const seed = join(t.context.installation.paths.scratch, traceOf(pi), 'seed');
      mkdirSync(join(seed, '1'), { recursive: true });
      writeFileSync(join(seed, '1', 'facts.md'), '# Apples\nRed.');
      return step;
    };
    pi.respond(
      scriptThen(fanOut({ items: ['apples'], each: 'Edit facts.md.', workspace: 'scratch:seed' })),
      () => toolCall('workspace_edit', { path: 'facts.md', edits: [{ oldText: 'Red.', newText: 'Red or green.' }] }),
      recording(asked, fauxAssistantMessage('edited')),
      fanOut({ items: ['apples'], each: 'Edit facts.md.', workspace: 'scratch:seed' }),
      fauxAssistantMessage('again'),
      fanOut({ items: ['apples'], each: 'Do it.', workspace: 'scratch:../seed' }),
      DONE,
    );
    await pi.prompt('Fan out.');
    const results = pi.results.filter((r) => r.tool === 'vault_fan_out');
    const spaces = results.slice(0, 2).map((r) => ((r.structured as { data: { items: { workspace: string }[] } }).data.items[0]?.workspace ?? ''));
    assert.notEqual(spaces[0], spaces[1], 'never the same workspace twice');
    const scratch = join(t.context.installation.paths.scratch, traceOf(pi));
    assert.equal(readFileSync(join(scratch, spaces[0] ?? '', 'facts.md'), 'utf8'), '# Apples\nRed or green.');
    assert.equal(readFileSync(join(scratch, spaces[1] ?? '', 'facts.md'), 'utf8'), '# Apples\nRed.', 'a fresh copy of the seed');
    assert.equal(readFileSync(join(scratch, 'seed', '1', 'facts.md'), 'utf8'), '# Apples\nRed.', 'the seed is never written');
    assert.equal(results[2]?.isError, true);
    assert.match(results[2]?.text ?? '', /not a directory in this session's scratch directory/);
  });
}, { running: RUNNING }));
