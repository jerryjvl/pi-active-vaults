// Documented behaviour: api.md "Tool contract" — results carry text for the
// model and structured content for programs; failures that carry information
// are errors the model can act on; large results are truncated with a note
// saying how to read the rest. extension.md "Unaccepted changes" — every vault
// tool result for a vault with an unaccepted change carries its notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelResult } from '../../../src/core/operations/index.ts';

test('a result is the text, any notices after it, and the same as data', () => {
  const result = modelResult({ status: 'ok', text: 'Found it.', data: { hits: 1 } }, ['Vault "home": main has 1 unaccepted commit(s).']);
  assert.equal(result.text, 'Found it.\n\nVault "home": main has 1 unaccepted commit(s).');
  assert.equal(result.isError, false);
  assert.deepEqual(result.structured, { status: 'ok', data: { hits: 1 }, text: 'Found it.', notices: ['Vault "home": main has 1 unaccepted commit(s).'] });
});

test('anything but success is an error the model can act on', () => {
  for (const status of ['failed', 'invalid', 'refused'] as const) assert.equal(modelResult({ status, text: 'No.' }, []).isError, true, status);
});

test('a long text is cut, with a note saying how much is left and how to read it', () => {
  const result = modelResult({ status: 'ok', text: 'x'.repeat(60_000) }, ['notice'], 50_000);
  assert.ok(result.text.length < 50_400);
  assert.match(result.text, /\[10000 more characters not shown: ask for less — a line range with vault_read, a narrower query or scope\.\]\n\nnotice$/);
  assert.equal((result.structured as { text: string }).text.length, 60_000, 'programs get it whole');
});

test('a confirmation is never offered to a model', () => {
  const result = modelResult({ status: 'refused', text: 'Shown.', confirm: { shown: 'Shown.', question: 'Adopt?', params: { yes: true } } }, []);
  assert.equal(JSON.stringify(result).includes('Adopt?'), false);
});
