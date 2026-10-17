// Documented behaviour: concepts.md "applies-when" — each condition names an
// event, filters on it and has an effect; fields belong to particular events.
// Parsing is strict: a condition that would be read differently from what its
// author meant (a misspelt or misplaced field) is an error, not ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConditions } from '../../../src/core/conditions/index.ts';

const issues = (value: unknown): string[] => {
  const parsed = parseConditions(value);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
};

test('the documented example parses, with defaults applied', () => {
  const parsed = parseConditions([
    { on: 'merged', paths: ['topics/cars/**'], change: ['created', 'modified'], effect: 'spawn' },
    { on: 'timer', schedule: '30 6 * * *', missed: 'run-once', effect: 'spawn' },
    { on: 'session.path', paths: ['projects/infrastructure/**'], effect: 'inject' },
  ]);
  assert.deepEqual(parsed, {
    ok: true,
    value: [
      { on: 'merged', paths: ['topics/cars/**'], change: ['created', 'modified'], effect: 'spawn', context: 'session-preferred' },
      { on: 'timer', schedule: '30 6 * * *', missed: 'run-once', effect: 'spawn', context: 'session-preferred' },
      { on: 'session.path', paths: ['projects/infrastructure/**'], effect: 'inject' },
    ],
  });
});

test('a timer runs a missed run once unless told to skip', () => {
  const parsed = parseConditions([{ on: 'timer', schedule: '0 * * * *', effect: 'spawn' }]);
  assert.equal(parsed.ok && parsed.value[0]?.missed, 'run-once');
});

test('each event takes only its own filters', () => {
  assert.deepEqual(issues([{ on: 'merged', schedule: '* * * * *', effect: 'spawn' }]), ['applies-when[0].schedule: does not apply to merged events']);
  assert.deepEqual(issues([{ on: 'session.start', paths: ['a/**'], effect: 'inject' }]), ['applies-when[0].paths: does not apply to session.start events']);
  assert.deepEqual(issues([{ on: 'external', effect: 'spawn' }]), ['applies-when[0].name: is required for external events']);
  assert.deepEqual(issues([{ on: 'timer', effect: 'spawn' }]), ['applies-when[0].schedule: is required for timer events']);
  assert.deepEqual(issues([{ on: 'session.tool', tools: ['bash'], labels: ['x'], effect: 'inject' }]), ['applies-when[0].labels: does not apply to session.tool events']);
});

test('only session events can inject, and only spawns take a context', () => {
  assert.deepEqual(issues([{ on: 'merged', effect: 'inject' }]), ['applies-when[0].effect: inject needs a session event']);
  assert.deepEqual(issues([{ on: 'session.start', effect: 'inject', context: 'bare' }]), ['applies-when[0].context: applies only to spawn']);
});

test('unknown fields, values and malformed globs are errors, and every problem is reported', () => {
  assert.deepEqual(issues([
    { on: 'merge', effect: 'spawn' },
    { on: 'merged', effect: 'run', chnage: ['created'] },
    { on: 'committed', change: ['moved'], paths: ['[x]'], effect: 'spawn' },
    { on: 'timer', schedule: 'every day', effect: 'spawn' },
  ]), [
    'applies-when[0].on: must be one of timer, committed, merged, session.start, session.tool, session.path, external',
    'applies-when[1].chnage: unknown key',
    'applies-when[1].effect: must be one of inject, spawn',
    'applies-when[2].paths[0]: character classes are not supported',
    'applies-when[2].change[0]: must be one of created, modified, deleted, renamed',
    'applies-when[3].schedule: must be a cron expression of five fields',
  ]);
  assert.deepEqual(issues({ on: 'merged' }), ['applies-when: must be a list']);
});
