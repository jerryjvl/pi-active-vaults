// `builtin:judge` (concepts.md "Script"): a job asks the installation's
// judgement models typed questions about content it supplies — screening
// research results for relevance, novelty or an injection attempt — and gets
// the answers back as JSON.
//
// Invariants:
//  - the answers are advisory: nothing is recorded, so they never become an
//    attestation and never satisfy a merge requirement (a model must not
//    approve its own work; this only lets a job sort what it found);
//  - questions use the axis format of contracts, `pass-when` optional; each is
//    answered by the judgement model it names, else the default, and only by
//    a model the policy allows for the run's vault — a question no permitted
//    model can answer is reported unjudged, and the others are still answered;
//  - content is data: it is sent only as the state, never as instructions;
//  - a model that cannot answer fails the run; nothing is guessed.
//
// Input (standard input, or `--file <path>` relative to the run's directory):
//   { "state": <object or text>, "questions": { <name>: <axis> } }
// Output: { "answers": { <name>: <answer> & { model, passed?, level? } },
//           "unjudged"?: { <name>: <reason> } }
// Exit: 0 answered, 1 a model failed, 2 usage, 3 nothing could be answered.

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { InstallationConfig } from '../config/index.ts';
import { askSystemOne, resolveModel, type ModelClient, type SystemOneAnswer } from '../models/index.ts';
import type { BuiltinScript, ScriptOutput } from '../scripts/index.ts';
import { axisVerdict, parseAxes, type Axis } from './axes.ts';

export interface JudgeBuiltinDeps {
  readonly config: Pick<InstallationConfig, 'models' | 'policy'>;
  readonly client: ModelClient;
}

const output = (exitCode: number, stdout: string, stderr = ''): ScriptOutput => ({ exitCode, stdout, stderr });

/** A neutral threshold for a question without one, so it parses as an axis; its `passed` is not reported. */
function withThreshold(definition: Record<string, unknown>): Record<string, unknown> {
  if (definition['pass-when'] !== undefined) return definition;
  if (definition['type'] === 'choice') {
    const first = Object.keys((definition['options'] ?? {}) as Record<string, unknown>)[0];
    return { ...definition, 'pass-when': { choices: first === undefined ? [] : [first], probability: 0.5 } };
  }
  if (definition['type'] === 'score') {
    const levels = Array.isArray(definition['levels']) ? definition['levels'] : [];
    return { ...definition, 'pass-when': { level: levels[0] } };
  }
  return { ...definition, 'pass-when': { probability: 0.5 } };
}

function readRequest(args: readonly string[], run: { readonly cwd: string; readonly input?: string }): { state: Record<string, unknown>; questions: Record<string, Record<string, unknown>> } | string {
  let file: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] !== '--file' || args[i + 1] === undefined || file !== undefined) return 'usage: builtin:judge [--file <path>] (the request as JSON on standard input otherwise)';
    file = args[i + 1];
  }
  let text: string;
  try {
    text = file === undefined ? run.input ?? '' : readFileSync(isAbsolute(file) ? file : resolve(run.cwd, file), 'utf8');
  } catch {
    return `usage: ${file ?? 'the input'} cannot be read`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'usage: the request must be JSON: { "state": …, "questions": { … } }';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'usage: the request must be a JSON object';
  const { state, questions } = parsed as { state?: unknown; questions?: unknown };
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions) || Object.keys(questions).length === 0) return 'usage: "questions" must name at least one question';
  if (typeof state === 'string') return { state: { content: state }, questions: questions as Record<string, Record<string, unknown>> };
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return 'usage: "state" must be an object or text';
  return { state: state as Record<string, unknown>, questions: questions as Record<string, Record<string, unknown>> };
}

function answerOf(axis: Axis, answer: SystemOneAnswer, model: string, thresholded: boolean): Record<string, unknown> {
  const level = axis.type === 'score' && answer.type === 'score' ? { level: axis.levels[Math.max(0, Math.min(axis.levels.length - 1, Math.round(answer.score)))] } : {};
  return { ...answer, ...level, model, ...(thresholded ? { passed: axisVerdict(axis, answer).result === 'pass' } : {}) };
}

/** The built-in, answering for content of the run's `vault`. */
export function judgeBuiltin(deps: JudgeBuiltinDeps, context: { readonly vault: string }): BuiltinScript {
  return {
    name: 'judge',
    header: {
      summary: 'Ask the judgement models typed questions about given content; advisory, never recorded',
      args: '[--file <path>] (the request as JSON on standard input otherwise)',
      output: 'json',
      net: true,
    },
    run: async (args, run) => {
      const request = readRequest(args, run);
      if (typeof request === 'string') return output(2, '', `${request}\n`);
      const axes = parseAxes(Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, typeof q === 'object' && q !== null ? withThreshold(q) : q])));
      if (!axes.ok) return output(2, '', `usage: ${axes.error.map((i) => `${i.path}: ${i.message}`).join('; ')}\n`);

      const answers: Record<string, Record<string, unknown>> = {};
      const unjudged: Record<string, string> = {};
      const byModel = new Map<string, { model: Extract<ReturnType<typeof resolveModel<'judgement'>>, { ok: true }>['value']; axes: Axis[] }>();
      for (const axis of axes.value) {
        const model = resolveModel(deps.config, 'judgement', [context.vault], axis.model);
        if (!model.ok) {
          unjudged[axis.name] = model.error.reason;
          continue;
        }
        const group = byModel.get(model.value.name) ?? { model: model.value, axes: [] };
        group.axes.push(axis);
        byModel.set(model.value.name, group);
      }
      for (const [name, { model, axes: asked }] of byModel) {
        const result = await askSystemOne(deps.client, model, { state: request.state, questions: Object.fromEntries(asked.map((a) => [a.name, a.question])) });
        if (!result.ok) return output(1, '', `the judgement model ${name} could not answer (${result.error.reason}${'status' in result.error ? ` ${result.error.status}` : ''})\n`);
        for (const axis of asked) {
          const answer = result.value.answers[axis.name];
          if (answer === undefined) return output(1, '', `the judgement model ${name} gave no answer for ${axis.name}\n`);
          answers[axis.name] = answerOf(axis, answer, name, request.questions[axis.name]?.['pass-when'] !== undefined);
        }
      }
      if (Object.keys(answers).length === 0) return output(3, `${JSON.stringify({ answers, unjudged })}\n`, 'no permitted judgement model could answer any question\n');
      return output(0, `${JSON.stringify(Object.keys(unjudged).length === 0 ? { answers } : { answers, unjudged })}\n`);
    },
  };
}
