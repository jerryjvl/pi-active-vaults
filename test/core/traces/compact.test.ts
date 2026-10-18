// Documented behaviour: concepts.md "Trace" — every run gets a unique,
// time-sortable trace ID; a compact record (triggers, sessions, judgements,
// scripts run, documents produced) is kept in the vault as a Git note on each
// of the run's commits, one line of JSON so notes merge line by line; when a
// run spans vaults, each records only its own part and other vaults appear as
// opaque references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource, isTraceId } from '../../../src/core/ids/index.ts';
import {
  newTraceId,
  opaqueReference,
  parseCompactTrace,
  renderCompactTrace,
  type CompactTrace,
} from '../../../src/core/traces/index.ts';
import { fakeClock } from '../../support/clock.ts';

const ids = () => createIdSource({ clock: fakeClock(), randomBytes: (n) => new Uint8Array(n) });

function sample(trace: string): CompactTrace {
  return {
    trace,
    vault: 'home',
    path: [],
    trigger: { event: 'merged', document: 'jobs/digest.md', commit: 'a'.repeat(40) },
    sessions: [{ actor: 'gardener', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', tokens: 1234, outcome: 'committed' }],
    judgements: [{ name: 'quality', subject: 'b'.repeat(40), result: 'pass' }],
    scripts: [{ name: 'due-topics', exitCode: 0 }],
    documents: ['digests/2026-01-01.md'],
    elsewhere: [],
  };
}

test('trace IDs are issued from the ID source: well formed and increasing', () => {
  const source = ids();
  const first = newTraceId(source);
  const second = newTraceId(source);
  assert.ok(isTraceId(first) && isTraceId(second));
  assert.ok(second > first);
});

test('a session ends committed, stopped, or with no changes', () => {
  const trace = sample(newTraceId(ids()));
  const nothing: CompactTrace = { ...trace, sessions: [{ actor: 'gardener', started: '2026-01-01T00:00:00.000Z', tokens: 80, outcome: 'no-change' }] };
  assert.deepEqual(parseCompactTrace(renderCompactTrace(nothing)), { ok: true, value: nothing });
});

test('a compact record is rendered deterministically as one line and read back unchanged', () => {
  const trace = sample(newTraceId(ids()));
  const text = renderCompactTrace(trace);
  assert.equal(text, renderCompactTrace({ ...trace }));
  assert.ok(text.startsWith('{') && text.endsWith('}') && !text.includes('\n'), 'one line, so notes merge line by line');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['trace', 'vault', 'path', 'trigger', 'sessions', 'judgements', 'scripts', 'documents', 'elsewhere']);
  assert.deepEqual(parseCompactTrace(text), { ok: true, value: trace });
});

test('a malformed compact record is refused with every problem, never read in part', () => {
  const id = newTraceId(ids());
  const bad = { ...sample(id), path: ['not-a-trace'], extra: 1, sessions: [{ actor: '', tokens: -1, outcome: 'committed', started: 'x' }] };
  const parsed = parseCompactTrace(JSON.stringify(bad));
  assert.ok(!parsed.ok);
  assert.deepEqual(parsed.error.map((i) => i.path).sort(), ['extra', 'path[0]', 'sessions[0].actor', 'sessions[0].tokens'].sort());
  assert.equal(parseCompactTrace('{ not json').ok, false);
});

test('another vault\'s part of a run is an opaque reference: stable, but naming neither the vault nor anything in it', () => {
  const id = newTraceId(ids());
  const ref = opaqueReference(id, 'private');
  assert.equal(ref, opaqueReference(id, 'private'));
  assert.notEqual(ref, opaqueReference(id, 'other'));
  const otherRun = `${id.slice(0, -1)}${id.endsWith('1') ? '2' : '1'}`;
  assert.notEqual(ref, opaqueReference(otherRun, 'private'), 'runs are not linkable through the reference');
  assert.ok(!ref.includes('private'));
  assert.match(ref, /^ref:[0-9a-f]{16}$/);
  assert.equal(parseCompactTrace(renderCompactTrace({ ...sample(id), elsewhere: [ref] })).ok, true);
  assert.equal(parseCompactTrace(JSON.stringify({ ...sample(id), elsewhere: ['private'] })).ok, false);
  assert.throws(() => renderCompactTrace({ ...sample(id), elsewhere: ['private'] }), /invalid compact trace/);
});
