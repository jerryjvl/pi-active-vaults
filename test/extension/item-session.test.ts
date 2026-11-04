// Documented behaviour: concepts.md "Session tree" — an item that fails is
// reported as failed, with why, and the others go on: an item whose session
// cannot even be made fails alone rather than ending the whole fan-out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runItem } from '../../src/extension/item-session.ts';

test('an item whose session cannot be made fails, with why, instead of throwing', async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), 'pav-item-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  // Settings Pi cannot read make its session manager throw while the session is made.
  const result = await runItem({ cwd: agentDir, model: { id: 'x', provider: 'faux', api: 'faux' } as never, prompt: 'Do it.', tools: [], mcp: {} }, { agentDir, settings: 'unreadable' as never });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /^the item's session could not start \(/);
});
