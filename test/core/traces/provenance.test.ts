// Documented behaviour: concepts.md "Document" and "Trace" — a produced
// document carries a `provenance` key, written by the runtime, with the trace
// ID and a compact causal path; the rest of the document is left as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource } from '../../../src/core/ids/index.ts';
import { newTraceId, provenanceOf, withProvenance } from '../../../src/core/traces/index.ts';
import { fakeClock } from '../../support/clock.ts';

const source = createIdSource({ clock: fakeClock(), randomBytes: (n) => new Uint8Array(n).fill(7) });
const root = newTraceId(source);
const parent = newTraceId(source);
const trace = newTraceId(source);

test('provenance names the trace and the causal path from the root, and leaves the rest of the document alone', () => {
  const text = '---\ntitle: Digest   # kept as written\nlabels: [cars]\n---\nBody text.\n';
  const written = withProvenance(text, { trace, path: [root, parent] });
  assert.ok(written.ok);
  assert.ok(written.value.startsWith('---\ntitle: Digest   # kept as written\nlabels: [cars]\n'));
  assert.ok(written.value.endsWith('---\nBody text.\n'));
  assert.deepEqual(provenanceOf(written.value), { trace, path: [root, parent] });
});

test('a document without frontmatter gains it; writing again replaces the provenance', () => {
  const first = withProvenance('Just prose.\n', { trace: root, path: [] });
  assert.ok(first.ok);
  assert.deepEqual(provenanceOf(first.value), { trace: root, path: [] });
  const again = withProvenance(first.value, { trace, path: [root] });
  assert.ok(again.ok);
  assert.deepEqual(provenanceOf(again.value), { trace, path: [root] });
  assert.equal(again.value.match(/provenance/g)?.length, 1);
});

test('missing or malformed provenance reads as none, never as a guess', () => {
  assert.equal(provenanceOf('No frontmatter.\n'), undefined);
  assert.equal(provenanceOf('---\nprovenance: someone\n---\n'), undefined);
  assert.equal(provenanceOf(`---\nprovenance: { trace: ${trace}, path: [nope] }\n---\n`), undefined);
  assert.equal(provenanceOf('---\nprovenance: [\n---\n'), undefined);
});

test('provenance that is not well formed is refused before anything is written', () => {
  assert.throws(() => withProvenance('x\n', { trace: 'not-a-trace', path: [] }), /trace ID/);
});
