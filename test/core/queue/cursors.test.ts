// Documented behaviour: architecture.md "Change-triggered work" and daemon.md
// "Catch-up" — each job keeps a cursor per event stream; events are derived
// from the cursor up to the accepted `main`, and the cursor advances once they
// are handled. Advancing is compare-and-swap, so two processes handling the
// same events cannot both move it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceCursor, gitStream, queueSchema, readCursor, timerStream } from '../../../src/core/queue/index.ts';
import { STATE_FILE, openStore, type Store } from '../../../src/core/store/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { withTempDir } from '../../support/temp-dir.ts';

function withStore(run: (store: Store) => void): () => Promise<void> {
  return withTempDir((dir) => {
    const opened = openStore(dir.file('state.sqlite'), STATE_FILE, [queueSchema]);
    assert.ok(opened.ok);
    try {
      run(opened.value);
    } finally {
      opened.value.close();
    }
  });
}

const key = { vault: 'home', document: 'jobs/digest.md', stream: gitStream('merged', 'home') };

test('streams are named by event kind and source vault, or by timer condition', () => {
  assert.equal(gitStream('merged', 'digests'), 'merged:digests');
  assert.equal(timerStream(2), 'timer:2');
});

test('a cursor starts unset and advances from where it was', withStore((store) => {
  const clock = fakeClock();
  assert.equal(readCursor(store, key), undefined);
  assert.ok(advanceCursor(store, clock, key, null, 'a'.repeat(40)).ok);
  assert.equal(readCursor(store, key), 'a'.repeat(40));
  assert.ok(advanceCursor(store, clock, key, 'a'.repeat(40), 'b'.repeat(40)).ok);
  assert.equal(readCursor(store, key), 'b'.repeat(40));
  assert.equal(readCursor(store, { ...key, stream: gitStream('merged', 'other') }), undefined, 'cursors are per stream');
}));

test('a cursor that moved meanwhile is not moved again', withStore((store) => {
  const clock = fakeClock();
  assert.ok(advanceCursor(store, clock, key, null, 'a'.repeat(40)).ok);
  const stale = advanceCursor(store, clock, key, null, 'c'.repeat(40));
  assert.deepEqual(!stale.ok && stale.error, { reason: 'cursor-moved', current: 'a'.repeat(40) });
  const wrong = advanceCursor(store, clock, key, 'c'.repeat(40), 'd'.repeat(40));
  assert.deepEqual(!wrong.ok && wrong.error, { reason: 'cursor-moved', current: 'a'.repeat(40) });
  assert.equal(readCursor(store, key), 'a'.repeat(40));
}));
