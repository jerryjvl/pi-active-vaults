// Documented behaviour: api.md "Flags" and extension.md "Headless sessions" —
// the daemon hands a headless session its run context in a file: the vault,
// the job document, the actor, the `agent` model it runs on, the run's trace and the triggering event. The
// file is read strictly: a run with an unreadable context does not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunContext, renderRunContext, type RunContext } from '../../../src/core/sessions/index.ts';

const RUN: RunContext = {
  vault: 'home', document: 'jobs/daily.md', actor: 'gardener', model: 'agent', trace: '01JABCDEFGHJKMNPQRSTVWXYZ1',
  event: { kind: 'committed', vault: 'home', commit: 'a'.repeat(40), changes: [{ path: 'notes/a.md', change: 'modified', labels: [], commit: 'a'.repeat(40) }] },
};

test('a run context reads back as it was written', () => {
  assert.deepEqual(parseRunContext(renderRunContext(RUN)), { ok: true, value: RUN });
});

test('a run context with anything missing, extra or malformed is refused, with every problem', () => {
  const bad = parseRunContext(JSON.stringify({ vault: 'home', trace: 'not-a-trace', actor: '', event: { kind: 'nonsense' }, extra: 1 }));
  assert.ok(!bad.ok);
  assert.deepEqual(bad.error.map((i) => i.path).sort(), ['actor', 'document', 'event.kind', 'extra', 'model', 'trace']);
  assert.ok(!parseRunContext('{ not json').ok);
  assert.ok(!parseRunContext('[]').ok);
});
