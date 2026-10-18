// Documented behaviour: architecture.md "Reads from the accepted main" — what
// is read from a vault's accepted main (jobs, contracts, conditions, script
// and check lists and the like) is cached in memory, keyed by vault and
// accepted-main SHA; the accepted SHA is looked up on each operation, so a
// newer one makes the next read load fresh content, and nothing is re-read
// while it is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcceptedReads, type AcceptedMain } from '../../../src/core/integrity/index.ts';

const at = (vault: string, sha: string) => ({ vault, sha: sha.repeat(40), how: 'accept', by: 'alice', at: '2026-01-01T00:00:00.000Z' }) as unknown as AcceptedMain;

function counting<T>(value: T): { load: () => Promise<T>; count: () => number } {
  let n = 0;
  return { load: async () => { n += 1; return value; }, count: () => n };
}

test('a read is loaded once for a vault and its accepted main, however often it is asked for', async () => {
  const reads = createAcceptedReads();
  const jobs = counting(['jobs/a.md']);
  assert.deepEqual(await reads.read(at('home', 'a'), 'jobs', jobs.load), ['jobs/a.md']);
  assert.deepEqual(await reads.read(at('home', 'a'), 'jobs', jobs.load), ['jobs/a.md']);
  assert.equal(jobs.count(), 1);
});

test('asked at the same moment, a read is loaded once', async () => {
  const reads = createAcceptedReads();
  const jobs = counting(1);
  await Promise.all([reads.read(at('home', 'a'), 'jobs', jobs.load), reads.read(at('home', 'a'), 'jobs', jobs.load)]);
  assert.equal(jobs.count(), 1);
});

test('a newer accepted main loads afresh, and what was read at the old one is dropped', async () => {
  const reads = createAcceptedReads();
  const jobs = counting(1);
  await reads.read(at('home', 'a'), 'jobs', jobs.load);
  await reads.read(at('home', 'b'), 'jobs', jobs.load);
  assert.equal(jobs.count(), 2);
  await reads.read(at('home', 'a'), 'jobs', jobs.load);
  assert.equal(jobs.count(), 3, 'only the accepted main last asked about is kept');
});

test('each vault, and each kind of read, is kept apart', async () => {
  const reads = createAcceptedReads();
  const loads = counting(1);
  await reads.read(at('home', 'a'), 'jobs', loads.load);
  await reads.read(at('work', 'a'), 'jobs', loads.load);
  await reads.read(at('home', 'a'), 'identity', loads.load);
  await reads.read(at('home', 'a'), 'jobs', loads.load);
  assert.equal(loads.count(), 3);
});

test('a read that failed is not kept: the next one tries again', async () => {
  const reads = createAcceptedReads();
  const failing = counting({ ok: false, error: { reason: 'timed-out' } });
  await reads.read(at('home', 'a'), 'jobs', failing.load);
  await reads.read(at('home', 'a'), 'jobs', failing.load);
  assert.equal(failing.count(), 2);
  const thrown = { n: 0 };
  const throwing = async () => { thrown.n += 1; throw new Error('boom'); };
  await assert.rejects(reads.read(at('home', 'a'), 'x', throwing));
  await assert.rejects(reads.read(at('home', 'a'), 'x', throwing));
  assert.equal(thrown.n, 2);
});
