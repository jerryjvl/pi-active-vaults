// Documented behaviour: errors are values — operations return typed results
// carrying a reason, and throw only for programming errors (core.md "Rules").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok, type Result } from '../../../src/core/result/index.ts';

function parsePort(text: string): Result<number, { reason: 'not-a-port'; input: string }> {
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port < 65536 ? ok(port) : err({ reason: 'not-a-port', input: text });
}

test('ok carries a value and err carries a reason, distinguished by `ok`', () => {
  const good = parsePort('8735');
  const bad = parsePort('nope');
  assert.deepEqual(good, { ok: true, value: 8735 });
  assert.deepEqual(bad, { ok: false, error: { reason: 'not-a-port', input: 'nope' } });
});

test('the failure branch narrows to the typed error', () => {
  const result = parsePort('0');
  if (result.ok) assert.fail('0 is not a port');
  assert.equal(result.error.reason, 'not-a-port');
});
