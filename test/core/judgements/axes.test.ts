// Documented behaviour: concepts.md "Judgement axes" — each axis is a typed
// question (`bool`, `choice`, `score`) with the answer that makes it pass:
//   bool   — the probability of `value` (default true) is at least `probability`;
//   choice — the listed options' combined probability is at least `probability`;
//   score  — the expected level is at least `level`, and the confidence at
//            least `confidence` when given.
// Parsing is strict: an axis that cannot be read exactly cannot pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisVerdict, parseAxes, type Axis } from '../../../src/core/judgements/index.ts';

const EXAMPLE = {
  evidence: {
    type: 'choice',
    instructions: 'What backs the main claims?',
    options: { primary: 'Cites data or a first-hand source', secondary: "Reports others' claims", opinion: 'Argument without sources' },
    'pass-when': { choices: ['primary', 'secondary'], probability: 0.7 },
  },
  relevance: {
    type: 'score',
    instructions: "How relevant is this to the vault's purpose?",
    levels: ['unrelated', 'tangential', 'relevant', 'core'],
    'pass-when': { level: 'relevant' },
  },
  'personal-data': {
    type: 'bool',
    instructions: 'Does this contain personal health or financial data?',
    true: 'Contains such data',
    false: 'Contains none',
    'pass-when': { value: false, probability: 0.9 },
  },
};

const issues = (value: unknown): string[] => {
  const parsed = parseAxes(value);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
};

function axis(name: string): Axis {
  const parsed = parseAxes(EXAMPLE);
  assert.ok(parsed.ok);
  const found = parsed.value.find((a) => a.name === name);
  assert.ok(found);
  return found;
}

test('the documented example parses into questions in the order given', () => {
  const parsed = parseAxes(EXAMPLE);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.map((a) => [a.name, a.type]), [['evidence', 'choice'], ['relevance', 'score'], ['personal-data', 'bool']]);
  assert.deepEqual(parsed.value.map((a) => a.question), [
    { type: 'choice', instructions: 'What backs the main claims?', criteria: EXAMPLE.evidence.options },
    { type: 'score', instructions: "How relevant is this to the vault's purpose?", criteria: EXAMPLE.relevance.levels },
    { type: 'bool', instructions: 'Does this contain personal health or financial data?', criteria: { true: 'Contains such data', false: 'Contains none' } },
  ]);
});

test('a bool passes when the probability of its value is at least the threshold; the value defaults to true', () => {
  const noPersonalData = axis('personal-data');
  assert.equal(axisVerdict(noPersonalData, { type: 'bool', probability: 0.1 }).result, 'pass', 'p(false) = 0.9');
  assert.equal(axisVerdict(noPersonalData, { type: 'bool', probability: 0.11 }).result, 'fail');
  const parsed = parseAxes({ sourced: { type: 'bool', instructions: 'Sourced?', true: 'yes', false: 'no', 'pass-when': { probability: 0.6 } } });
  assert.ok(parsed.ok && parsed.value[0] !== undefined);
  assert.equal(axisVerdict(parsed.value[0], { type: 'bool', probability: 0.6 }).result, 'pass');
  assert.equal(axisVerdict(parsed.value[0], { type: 'bool', probability: 0.59 }).result, 'fail');
});

test('a choice passes on the listed options\' combined probability, whichever option was chosen', () => {
  const evidence = axis('evidence');
  const answer = (probabilities: Record<string, number>, choice = 'opinion') => ({ type: 'choice' as const, choice, probabilities, confidence: 0.5 });
  assert.equal(axisVerdict(evidence, answer({ primary: 0.4, secondary: 0.3, opinion: 0.3 })).result, 'pass');
  assert.equal(axisVerdict(evidence, answer({ primary: 0.4, secondary: 0.29, opinion: 0.31 })).result, 'fail');
  assert.equal(axisVerdict(evidence, answer({ primary: 0.75 }, 'primary')).result, 'pass', 'an option not given counts as zero');
  assert.match(axisVerdict(evidence, answer({ primary: 0.75 }, 'primary')).evidence, /0\.75/);
});

test('a score passes at or above its level, and at or above the confidence when one is asked for', () => {
  const relevance = axis('relevance');
  assert.equal(axisVerdict(relevance, { type: 'score', score: 2, confidence: 0.1 }).result, 'pass');
  assert.equal(axisVerdict(relevance, { type: 'score', score: 1.99, confidence: 1 }).result, 'fail');
  const confident = parseAxes({ r: { ...EXAMPLE.relevance, 'pass-when': { level: 'tangential', confidence: 0.8 } } });
  assert.ok(confident.ok && confident.value[0] !== undefined);
  assert.equal(axisVerdict(confident.value[0], { type: 'score', score: 3, confidence: 0.8 }).result, 'pass');
  assert.equal(axisVerdict(confident.value[0], { type: 'score', score: 3, confidence: 0.79 }).result, 'fail');
});

test('an answer of another type than the axis fails it', () => {
  assert.equal(axisVerdict(axis('relevance'), { type: 'bool', probability: 1 }).result, 'fail');
});

test('every problem with an axis is reported; nothing is assumed', () => {
  assert.deepEqual(issues({ a: { type: 'choice', instructions: 'Q', options: { x: 'X' } } }), ['axes.a.pass-when: is required']);
  assert.deepEqual(issues({ a: { type: 'choice', instructions: 'Q', options: { x: 'X' }, 'pass-when': { choices: ['y'], probability: 0.5 } } }), ['axes.a.pass-when.choices[0]: is not one of the options']);
  assert.deepEqual(issues({ a: { type: 'score', instructions: 'Q', levels: ['low', 'high'], 'pass-when': { level: 'mid' } } }), ['axes.a.pass-when.level: is not one of the levels']);
  assert.deepEqual(issues({ a: { type: 'score', instructions: 'Q', levels: ['only'], 'pass-when': { level: 'only' } } }), ['axes.a.levels: must name at least two levels']);
  assert.deepEqual(issues({ a: { type: 'bool', instructions: 'Q', true: 'yes', 'pass-when': { probability: 0.5 } } }), ['axes.a.false: must be a non-empty string']);
  assert.deepEqual(issues({ a: { type: 'bool', instructions: 'Q', true: 'y', false: 'n', 'pass-when': { probability: 1.5 } } }), ['axes.a.pass-when.probability: must be a number from 0 to 1']);
  assert.deepEqual(issues({ a: { type: 'bool', instructions: 'Q', true: 'y', false: 'n', 'pass-when': {} } }), ['axes.a.pass-when.probability: is required']);
  assert.deepEqual(issues({ a: { type: 'maybe', instructions: 'Q' } }), ['axes.a.type: must be one of bool, choice, score']);
  assert.deepEqual(issues({ a: { type: 'bool', instructions: 'Q', true: 'y', false: 'n', options: {}, 'pass-when': { probability: 0.5 } } }), ['axes.a.options: unknown key']);
  assert.deepEqual(issues([]), ['axes: must be a mapping']);
});
