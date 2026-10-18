// Documented behaviour: concepts.md "Session tree" (fan-out and gather) and
// api.md `vault_fan_out` — a list of items, an instruction for each, an
// instruction to combine the results; the item sessions return results and do
// not write, and the session that fanned out writes what is gathered. Without
// the daemon it runs sequentially in the session (architecture.md
// "Degradation"). Its work counts against the session's budget, and a headless
// run that has used its budget fans out no further. Tested through Pi 1.3.0's
// SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type FauxResponseStep } from '@earendil-works/pi-ai';
import { withInstallation } from '../support/installation.ts';
import { toolResults, withPi } from '../support/pi.ts';
import { RUNNING } from '../support/session.ts';

const fanOut = (args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall('vault_fan_out', args), { stopReason: 'toolUse' });

/** An item or gather answer that records what it was asked, and whether it was offered any tools. */
function answer(text: string, asked: { prompt: string; tools: number }[]): FauxResponseStep {
  return (context) => {
    const last = context.messages.at(-1) as { content: unknown };
    const prompt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const tools = getCurrentTools(context.messages).length;
    asked.push({ prompt, tools });
    return fauxAssistantMessage(text);
  };
}

test('each item is done in turn without tools, then the results are gathered, all returned to the session', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const asked: { prompt: string; tools: number }[] = [];
    pi.respond(
      fanOut({ items: ['apples', 'pears'], each: 'Say the colour of the item.', gather: 'List the colours.' }),
      answer('red', asked), answer('green', asked), answer('red, green', asked),
      fauxAssistantMessage('Done.'),
    );
    await pi.prompt('Fan out.');
    assert.equal(asked.length, 3);
    assert.match(asked[0]?.prompt ?? '', /Say the colour of the item\.[^]*apples/);
    assert.match(asked[1]?.prompt ?? '', /pears/);
    assert.match(asked[2]?.prompt ?? '', /List the colours\.[^]*apples[^]*red[^]*pears[^]*green/);
    assert.deepEqual(asked.map((a) => a.tools), [0, 0, 0], 'item and gather sessions cannot write');
    assert.match(toolResults(pi.requests.at(-1), 'vault_fan_out')[0] ?? '', /red, green/);
    const structured = pi.results.find((r) => r.tool === 'vault_fan_out')?.structured as { data: { gathered: string; items: { item: string; outcome: string; result?: string }[] } };
    assert.deepEqual(structured.data.items.map((i) => [i.item, i.outcome, i.result]), [['apples', 'done', 'red'], ['pears', 'done', 'green']]);
    assert.equal(structured.data.gathered, 'red, green');
  });
}, { running: RUNNING }));

test('an item whose model call fails is reported as failed; the others still gather', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const asked: { prompt: string; tools: number }[] = [];
    pi.respond(
      fanOut({ items: ['a', 'b'], each: 'Do it.', gather: 'Combine.' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }), answer('B', asked), answer('only B', asked),
      fauxAssistantMessage('Done.'),
    );
    await pi.prompt('Fan out.');
    const structured = pi.results.find((r) => r.tool === 'vault_fan_out')?.structured as { data: { items: { item: string; outcome: string }[] } };
    assert.deepEqual(structured.data.items.map((i) => [i.item, i.outcome]), [['a', 'failed'], ['b', 'done']]);
  });
}, { running: RUNNING }));

test('no items is a request the model should fix', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    pi.respond(fanOut({ items: [], each: 'Do it.', gather: 'Combine.' }), fauxAssistantMessage('Done.'));
    await pi.prompt('Fan out.');
    assert.equal(pi.results.find((r) => r.tool === 'vault_fan_out')?.isError, true);
  });
}, { running: RUNNING }));
