// Documented behaviour: validation reports every problem, by location only
// (concepts.md "Installation": "lists every problem (without repeating the
// values)"); the same reader validates config, frontmatter and headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataReader, issuePath } from '../../../src/core/result/index.ts';

test('a reader collects every issue by path, never by value, and yields a value only when there were none', () => {
  const r = new DataReader();
  const record = r.record({ name: 'x', secret: 'hunter2', kind: 'odd' }, 'top', ['name', 'kind']);
  r.oneOf(record['kind'], issuePath('top', 'kind'), ['a', 'b'] as const);
  r.string(record['missing'], issuePath('top', 'missing'));
  assert.deepEqual(r.issues.map((i) => i.path), ['top.secret', 'top.kind', 'top.missing']);
  assert.ok(!JSON.stringify(r.issues).includes('hunter2'));
  assert.equal(r.result('value').ok, false);
  assert.deepEqual(new DataReader().result('value'), { ok: true, value: 'value' });
});

test('issue paths are dotted, and a top-level key stands alone', () => {
  assert.equal(issuePath('', 'vault'), 'vault');
  assert.equal(issuePath('vault', 'owners'), 'vault.owners');
});
