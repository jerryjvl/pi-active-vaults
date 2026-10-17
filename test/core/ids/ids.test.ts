// Documented behaviour: every run gets a unique, time-sortable ID (concepts.md
// "Trace"); the ID appears in file names, so it is case-insensitive-safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdSource, isTraceId, traceIdTime, type RandomBytes } from '../../../src/core/ids/index.ts';
import { fakeClock } from '../../support/clock.ts';

const zeros: RandomBytes = (length) => new Uint8Array(length);

test('an ID is 26 upper-case Crockford base32 characters: time first, then randomness', () => {
  const ids = createIdSource({ clock: fakeClock('1970-01-01T00:00:00.032Z'), randomBytes: zeros });
  // 32 ms is "10" in base32; the 80 random bits are all zero.
  assert.equal(ids.next(), '0000000010' + '0000000000000000');
});

test('IDs sort in the order they were issued as the clock advances', () => {
  const clock = fakeClock();
  const ids = createIdSource({ clock, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) });
  const issued: string[] = [];
  for (let i = 0; i < 200; i++) {
    issued.push(ids.next());
    clock.advance(i % 3);
  }
  assert.deepEqual([...issued].sort(), issued);
  assert.equal(new Set(issued).size, issued.length);
});

test('IDs issued in the same millisecond stay unique and increasing even with identical randomness', () => {
  const ids = createIdSource({ clock: fakeClock(), randomBytes: zeros });
  const issued = [ids.next(), ids.next(), ids.next()];
  assert.deepEqual([...issued].sort(), issued);
  assert.equal(new Set(issued).size, 3);
});

test('a clock that steps backwards never makes a later ID sort earlier', () => {
  const clock = fakeClock();
  const ids = createIdSource({ clock, randomBytes: zeros });
  const first = ids.next();
  clock.advance(-60_000);
  const second = ids.next();
  assert.ok(second > first);
});

test('randomness comes only from the injected source', () => {
  const requested: number[] = [];
  const ids = createIdSource({
    clock: fakeClock(),
    randomBytes: (length) => {
      requested.push(length);
      return new Uint8Array(length).fill(0xff);
    },
  });
  assert.match(ids.next(), /^[0-9A-Z]{10}ZZZZZZZZZZZZZZZZ$/);
  assert.equal(requested.length, 1);
});

test('the time an ID was issued can be read back, so a trace file can be located by ID alone', () => {
  const clock = fakeClock('2026-05-17T09:30:15.250Z');
  const id = createIdSource({ clock, randomBytes: zeros }).next();
  assert.equal(traceIdTime(id)?.toISOString(), '2026-05-17T09:30:15.250Z');
});

test('malformed IDs are rejected rather than guessed at', () => {
  const valid = createIdSource({ clock: fakeClock(), randomBytes: zeros }).next();
  assert.equal(isTraceId(valid), true);
  for (const bad of ['', valid.toLowerCase(), valid.slice(1), valid + '0', valid.replace(/.$/, 'U'), '../' + valid.slice(3)]) {
    assert.equal(isTraceId(bad), false, bad);
    assert.equal(traceIdTime(bad), undefined, bad);
  }
});

test('a source of randomness that returns the wrong amount is a programming error', () => {
  const ids = createIdSource({ clock: fakeClock(), randomBytes: () => new Uint8Array(3) });
  assert.throws(() => ids.next());
});
