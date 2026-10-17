// Documented behaviour: concepts.md "Trace" and daemon.md "Log rotation" —
// full logs are kept on the machine under `<state>/logs/<date>/<trace-id>/`,
// per day and trace, readable only by the user; today's files stay as written,
// files from earlier days are gzip-compressed, and days older than
// `logs.keep-days` are deleted. A trace's full detail can be read back while
// its logs are retained.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createIdSource } from '../../../src/core/ids/index.ts';
import { appendFullLog, newTraceId, readFullLog, rotateLogs } from '../../../src/core/traces/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const DAY = 24 * 60 * 60 * 1000;
const posixModes = { skip: process.platform === 'win32' ? 'POSIX permission bits' : false };

function traceAt(clock: ReturnType<typeof fakeClock>): string {
  return newTraceId(createIdSource({ clock, randomBytes: (n) => new Uint8Array(n) }));
}

test('log lines are appended per day and trace, as JSON lines', withTempDir((dir) => {
  const clock = fakeClock('2026-03-04T23:59:00.000Z');
  const trace = traceAt(clock);
  assert.ok(appendFullLog(dir.path, clock, trace, 'session.jsonl', { turn: 1 }).ok);
  assert.ok(appendFullLog(dir.path, clock, trace, 'session.jsonl', { turn: 2 }).ok);
  clock.advance(2 * 60 * 1000); // past midnight: the next day's directory
  assert.ok(appendFullLog(dir.path, clock, trace, 'session.jsonl', { turn: 3 }).ok);
  assert.deepEqual(readdirSync(dir.path).sort(), ['2026-03-04', '2026-03-05']);
  assert.deepEqual(readFullLog(dir.path, trace), [
    { day: '2026-03-04', name: 'session.jsonl', text: '{"turn":1}\n{"turn":2}\n' },
    { day: '2026-03-05', name: 'session.jsonl', text: '{"turn":3}\n' },
  ]);
}));

test('log directories and files are private to the user', posixModes, withTempDir((dir) => {
  const clock = fakeClock();
  const trace = traceAt(clock);
  assert.ok(appendFullLog(dir.path, clock, trace, 'session.jsonl', {}).ok);
  assert.equal(statSync(dir.file('2026-01-01')).mode & 0o777, 0o700);
  assert.equal(statSync(dir.file('2026-01-01', trace)).mode & 0o777, 0o700);
  assert.equal(statSync(dir.file('2026-01-01', trace, 'session.jsonl')).mode & 0o777, 0o600);
}));

test('a trace ID or log name that could leave the log directory is refused', withTempDir((dir) => {
  const clock = fakeClock();
  for (const [trace, name] of [['../escape', 'a.jsonl'], [traceAt(clock), '../a.jsonl'], [traceAt(clock), 'a.jsonl.gz'], [traceAt(clock), '']]) {
    const appended = appendFullLog(dir.path, clock, trace as string, name as string, {});
    assert.equal(!appended.ok && appended.error.reason, 'invalid-name', `${trace} ${name}`);
  }
  assert.deepEqual(readdirSync(dir.path), []);
}));

test('rotation leaves today alone, compresses earlier days, and deletes days older than the retention', withTempDir((dir) => {
  const clock = fakeClock('2026-03-01T12:00:00.000Z');
  const trace = traceAt(clock);
  for (let day = 0; day < 10; day++) {
    assert.ok(appendFullLog(dir.path, clock, trace, 'session.jsonl', { day }).ok);
    clock.advance(DAY);
  }
  clock.advance(-DAY); // now 2026-03-10, the last day written
  const rotated = rotateLogs(dir.path, clock, 7);
  assert.deepEqual(rotated.deleted, ['2026-03-01', '2026-03-02', '2026-03-03']);
  assert.equal(rotated.compressed.length, 6);
  assert.deepEqual(readdirSync(dir.path).sort(), ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  assert.ok(existsSync(dir.file('2026-03-10', trace, 'session.jsonl')), 'today stays as written');
  assert.ok(existsSync(dir.file('2026-03-09', trace, 'session.jsonl.gz')));
  assert.ok(!existsSync(dir.file('2026-03-09', trace, 'session.jsonl')));
  // Compressed days still read back as they were written.
  const read = readFullLog(dir.path, trace);
  assert.deepEqual(read.map((entry) => [entry.day, entry.name, entry.text]), [
    ['2026-03-04', 'session.jsonl', '{"day":3}\n'], ['2026-03-05', 'session.jsonl', '{"day":4}\n'],
    ['2026-03-06', 'session.jsonl', '{"day":5}\n'], ['2026-03-07', 'session.jsonl', '{"day":6}\n'],
    ['2026-03-08', 'session.jsonl', '{"day":7}\n'], ['2026-03-09', 'session.jsonl', '{"day":8}\n'],
    ['2026-03-10', 'session.jsonl', '{"day":9}\n'],
  ]);
  assert.deepEqual(rotateLogs(dir.path, clock, 7), { compressed: [], deleted: [] }, 'rotation is idempotent');
}));

test('rotation touches only day directories it wrote', withTempDir((dir) => {
  mkdirSync(dir.file('not-a-day'));
  writeFileSync(dir.file('notes.txt'), 'x');
  const rotated = rotateLogs(dir.path, fakeClock(), 1);
  assert.deepEqual(rotated, { compressed: [], deleted: [] });
  assert.deepEqual(readdirSync(dir.path).sort(), ['not-a-day', 'notes.txt']);
}));

test('a trace with no logs, or whose logs have rotated away, reads as empty', withTempDir((dir) => {
  assert.deepEqual(readFullLog(dir.path, traceAt(fakeClock())), []);
  assert.deepEqual(readFullLog(dir.file('missing'), traceAt(fakeClock())), []);
}));
