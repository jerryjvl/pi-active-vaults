// Documented behaviour: concepts.md "Merge policy" — `merge` is a list of rules,
// each with path globs, required `checks`, `owner` or `judgement:<name>`, and
// optional `when-tainted` requirements. Parsing is strict: an unknown
// requirement must not be read as "no requirement".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMergeRules } from '../../../src/core/policy/index.ts';

const issues = (value: unknown): string[] => {
  const parsed = parseMergeRules(value);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
};

test('the documented rule parses, and when-tainted defaults to nothing extra', () => {
  assert.deepEqual(parseMergeRules([
    { paths: ['**'], require: ['checks', 'owner'] },
    { paths: ['topics/**'], require: ['judgement:quality'], 'when-tainted': ['owner'] },
  ]), {
    ok: true,
    value: [
      { paths: ['**'], require: ['checks', 'owner'], whenTainted: [] },
      { paths: ['topics/**'], require: ['judgement:quality'], whenTainted: ['owner'] },
    ],
  });
});

test('unknown requirements, keys and malformed globs are errors, all reported', () => {
  assert.deepEqual(issues([
    { paths: ['**'], require: ['owners', 'judgement:', 'judgement:a b'] },
    { path: ['**'], require: ['owner'] },
    { paths: ['[x]'], require: [] },
  ]), [
    'merge[0].require[0]: must be checks, owner or judgement:<name>',
    'merge[0].require[1]: must be checks, owner or judgement:<name>',
    'merge[0].require[2]: must be checks, owner or judgement:<name>',
    'merge[1].path: unknown key',
    'merge[1].paths: must be a list',
    'merge[2].paths[0]: character classes are not supported',
    'merge[2]: must require something, plainly or when tainted',
  ]);
  assert.deepEqual(issues({ paths: ['**'] }), ['merge: must be a list']);
});
