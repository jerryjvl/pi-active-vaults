// Judgement axes (concepts.md "Judgement axes"): the questions a judgement
// asks of a document, each with the answer that makes it pass.
//
// Parsing is strict, like every gate's definition: an axis that cannot be
// read exactly is an issue, never a question with a guessed threshold. An
// axis's name is what a merge rule requires (`judgement:<name>`), so it has
// that form. `pass-when` reads "at least": a bool passes when the probability
// of its `value` reaches `probability`; a choice when its listed options'
// combined probability does (an option the model did not give counts as 0);
// a score when its expected level reaches `level` and, if asked, its
// confidence reaches `confidence`. An answer of another type fails.

import type { SystemOneAnswer, SystemOneQuestion } from '../models/index.ts';
import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

const TYPES = ['bool', 'choice', 'score'] as const;
const AXIS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Floating-point sums such as 0.4 + 0.3 must not fall short of a threshold of 0.7.
const TOLERANCE = 1e-9;

interface AxisBase {
  readonly name: string;
  /** The axis as the contract defines it: what its version is computed from. */
  readonly definition: unknown;
  readonly question: SystemOneQuestion;
}

export type Axis = AxisBase & (
  | { readonly type: 'bool'; readonly passWhen: { readonly value: boolean; readonly probability: number } }
  | { readonly type: 'choice'; readonly passWhen: { readonly choices: readonly string[]; readonly probability: number } }
  | { readonly type: 'score'; readonly levels: readonly string[]; readonly passWhen: { readonly level: number; readonly confidence?: number } }
);

export interface AxisVerdict {
  readonly result: 'pass' | 'fail';
  /** Short: the probability or level found, against what was needed. */
  readonly evidence: string;
}

function unit(r: DataReader, record: Record<string, unknown>, key: string, where: string, required: boolean): number | undefined {
  const value = record[key];
  const path = issuePath(where, key);
  if (value === undefined) {
    if (required) r.add(path, 'is required');
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    r.add(path, 'must be a number from 0 to 1');
    return undefined;
  }
  return value;
}

function readPassWhen(r: DataReader, a: Record<string, unknown>, where: string, allowed: readonly string[]): Record<string, unknown> | undefined {
  const path = issuePath(where, 'pass-when');
  if (a['pass-when'] === undefined) {
    r.add(path, 'is required');
    return undefined;
  }
  return r.record(a['pass-when'], path, allowed);
}

function readAxis(r: DataReader, name: string, value: unknown, where: string): Axis | undefined {
  if (!AXIS_NAME.test(name)) r.add(where, 'must be a name of letters, digits, ".", "_" or "-"');
  const type = r.oneOf(r.record(value, where)['type'], issuePath(where, 'type'), TYPES);
  if (type === undefined) return undefined;
  const common = ['type', 'instructions', 'pass-when'];
  const keys = type === 'bool' ? [...common, 'true', 'false'] : type === 'choice' ? [...common, 'options'] : [...common, 'levels'];
  const a = r.record(value, where, keys);
  const instructions = r.string(a['instructions'], issuePath(where, 'instructions'));
  const at = (key: string): string => issuePath(issuePath(where, 'pass-when'), key);

  switch (type) {
    case 'bool': {
      const criteria = { true: r.string(a['true'], issuePath(where, 'true')), false: r.string(a['false'], issuePath(where, 'false')) };
      const p = readPassWhen(r, a, where, ['value', 'probability']) ?? {};
      if (p['value'] !== undefined && typeof p['value'] !== 'boolean') r.add(at('value'), 'must be true or false');
      const probability = unit(r, p, 'probability', issuePath(where, 'pass-when'), a['pass-when'] !== undefined) ?? 1;
      return { name, definition: value, type, question: { type, instructions, criteria }, passWhen: { value: p['value'] !== false, probability } };
    }
    case 'choice': {
      const options = r.record(a['options'], issuePath(where, 'options'));
      const criteria = Object.fromEntries(Object.entries(options).map(([option, meaning]) => [option, r.string(meaning, issuePath(issuePath(where, 'options'), option))]));
      if (Object.keys(criteria).length === 0 && typeof a['options'] === 'object') r.add(issuePath(where, 'options'), 'must name at least one option');
      const p = readPassWhen(r, a, where, ['choices', 'probability']) ?? {};
      let choices: string[] = [];
      if (p['choices'] !== undefined) choices = r.stringList(p['choices'], at('choices'));
      else if (a['pass-when'] !== undefined) r.add(at('choices'), 'is required');
      choices.forEach((choice, i) => {
        if (choice !== '' && !Object.hasOwn(criteria, choice)) r.add(`${at('choices')}[${i}]`, 'is not one of the options');
      });
      const probability = unit(r, p, 'probability', issuePath(where, 'pass-when'), a['pass-when'] !== undefined) ?? 1;
      return { name, definition: value, type, question: { type, instructions, criteria }, passWhen: { choices, probability } };
    }
    case 'score': {
      const levels = r.stringList(a['levels'], issuePath(where, 'levels'));
      if (Array.isArray(a['levels']) && levels.length < 2) r.add(issuePath(where, 'levels'), 'must name at least two levels');
      const p = readPassWhen(r, a, where, ['level', 'confidence']) ?? {};
      let level = levels.length;
      if (p['level'] === undefined) {
        if (a['pass-when'] !== undefined) r.add(at('level'), 'is required');
      } else if (typeof p['level'] !== 'string' || !levels.includes(p['level'])) {
        r.add(at('level'), 'is not one of the levels');
      } else {
        level = levels.indexOf(p['level']);
      }
      const confidence = unit(r, p, 'confidence', issuePath(where, 'pass-when'), false);
      return {
        name, definition: value, type, levels, question: { type, instructions, criteria: levels },
        passWhen: { level, ...(confidence === undefined ? {} : { confidence }) },
      };
    }
  }
}

/** The axes of an effective contract, in the order defined; every problem is reported. */
export function parseAxes(value: unknown, where = 'axes'): Result<Axis[], Issue[]> {
  const r = new DataReader();
  const axes = Object.entries(r.record(value, where)).flatMap(([name, definition]) => readAxis(r, name, definition, issuePath(where, name)) ?? []);
  return r.result(axes);
}

const shown = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Whether the answer passes the axis, and the evidence for it. */
export function axisVerdict(axis: Axis, answer: SystemOneAnswer): AxisVerdict {
  const verdict = (passed: boolean, evidence: string): AxisVerdict => ({ result: passed ? 'pass' : 'fail', evidence });
  if (axis.type !== answer.type) return verdict(false, `answered as ${answer.type}, not ${axis.type}`);
  switch (axis.type) {
    case 'bool': {
      const { probability } = answer as Extract<SystemOneAnswer, { type: 'bool' }>;
      const p = axis.passWhen.value ? probability : 1 - probability;
      return verdict(p + TOLERANCE >= axis.passWhen.probability, `p(${axis.passWhen.value}) = ${shown(p)}, needs ${axis.passWhen.probability}`);
    }
    case 'choice': {
      const { choice, probabilities } = answer as Extract<SystemOneAnswer, { type: 'choice' }>;
      const p = axis.passWhen.choices.reduce((sum, option) => sum + (probabilities[option] ?? 0), 0);
      return verdict(p + TOLERANCE >= axis.passWhen.probability, `p(${axis.passWhen.choices.join(', ')}) = ${shown(p)}, needs ${axis.passWhen.probability}; chose ${choice}`);
    }
    case 'score': {
      const { score, confidence } = answer as Extract<SystemOneAnswer, { type: 'score' }>;
      const { level, confidence: needed } = axis.passWhen;
      const passed = score + TOLERANCE >= level && (needed === undefined || confidence + TOLERANCE >= needed);
      const confidenceText = needed === undefined ? `confidence ${shown(confidence)}` : `confidence ${shown(confidence)}, needs ${needed}`;
      return verdict(passed, `level ${shown(score)}, needs ${level} (${axis.levels[level] ?? '?'}); ${confidenceText}`);
    }
  }
}
