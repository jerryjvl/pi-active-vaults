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
// Input (standard input, or `--file <path>` — relative to the run's directory,
// or `scratch:<name>` in the session's scratch directory):
//   { "state": <object or text>, "questions": { <name>: <axis> } }
// Output: { "answers": { <name>: <answer> & { model, passed?, level? } },
//           "unjudged"?: { <name>: <reason> } }
// Exit: 0 answered, 1 a model failed, 2 usage, 3 nothing could be answered.
//
// A batch asks many at once: { "questions"?: <shared>, "batch": [{ "id", "state",
// "questions"? }] } (an entry's own questions replace the shared ones), and
// answers { "results": { <id>: <output> | { "error": <why> } } }; one entry's
// failure does not stop the others, and the exit is 1 if any failed.
// `--out scratch:<name>` writes the output there and prints only a summary, so
// a long batch need not pass through the caller's context.

import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { scratchFile, SCRATCH_VARIABLE, type InstallationConfig } from '../config/index.ts';
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

const USAGE = 'usage: builtin:judge [--file <path>|scratch:<name>] [--out scratch:<name>] (the request as JSON on standard input otherwise)';

type Questions = Record<string, Record<string, unknown>>;
interface Request { readonly state: Record<string, unknown>; readonly questions: Questions }
type Parsed = { readonly single: Request } | { readonly batch: readonly { readonly id: string; readonly request: Request | string }[] };

function questionsOf(value: unknown): Questions | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0 ? value as Questions : undefined;
}

function requestOf(state: unknown, questions: unknown): Request | string {
  const asked = questionsOf(questions);
  if (asked === undefined) return '"questions" must name at least one question';
  if (typeof state === 'string') return { state: { content: state }, questions: asked };
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return '"state" must be an object or text';
  return { state: state as Record<string, unknown>, questions: asked };
}

function readArgs(args: readonly string[]): { file?: string; out?: string } | string {
  const found: { file?: string; out?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if ((flag !== '--file' && flag !== '--out') || value === undefined) return USAGE;
    const key = flag === '--file' ? 'file' : 'out';
    if (found[key] !== undefined) return USAGE;
    found[key] = value;
  }
  return found;
}

function readRequest(file: string | undefined, run: { readonly cwd: string; readonly input?: string }, scratch: string | undefined): Parsed | string {
  let text: string;
  if (file === undefined) text = run.input ?? '';
  else {
    const path = file.startsWith('scratch:') ? scratchFile(scratch, file) : isAbsolute(file) ? file : resolve(run.cwd, file);
    if (path === undefined) return `usage: ${file} is not a file in this session's scratch directory`;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return `usage: ${file} cannot be read`;
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'usage: the request must be JSON: { "state": …, "questions": { … } }';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'usage: the request must be a JSON object';
  const { state, questions, batch } = parsed as { state?: unknown; questions?: unknown; batch?: unknown };
  if (batch === undefined) {
    const request = requestOf(state, questions);
    return typeof request === 'string' ? `usage: ${request}` : { single: request };
  }
  if (!Array.isArray(batch) || batch.length === 0) return 'usage: "batch" must list at least one entry';
  const ids = new Set<string>();
  const entries: { id: string; request: Request | string }[] = [];
  for (const entry of batch as unknown[]) {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as { id?: unknown; state?: unknown; questions?: unknown };
    if (typeof e.id !== 'string' || e.id === '' || ids.has(e.id)) return 'usage: every batch entry needs an "id" of its own';
    ids.add(e.id);
    entries.push({ id: e.id, request: requestOf(e.state, e.questions ?? questions) });
  }
  return { batch: entries };
}

function answerOf(axis: Axis, answer: SystemOneAnswer, model: string, thresholded: boolean): Record<string, unknown> {
  const level = axis.type === 'score' && answer.type === 'score' ? { level: axis.levels[Math.max(0, Math.min(axis.levels.length - 1, Math.round(answer.score)))] } : {};
  return { ...answer, ...level, model, ...(thresholded ? { passed: axisVerdict(axis, answer).result === 'pass' } : {}) };
}

type Judged =
  | { readonly ok: true; readonly body: { answers: Record<string, Record<string, unknown>>; unjudged?: Record<string, string> } }
  | { readonly ok: false; readonly exitCode: number; readonly message: string; readonly body?: object };

/** One request's answers, each question by the model it names (else the default) that the policy allows for `vault`. */
async function judge(deps: JudgeBuiltinDeps, vault: string, request: Request): Promise<Judged> {
  const axes = parseAxes(Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, typeof q === 'object' && q !== null ? withThreshold(q) : q])));
  if (!axes.ok) return { ok: false, exitCode: 2, message: `usage: ${axes.error.map((i) => `${i.path}: ${i.message}`).join('; ')}` };
  const answers: Record<string, Record<string, unknown>> = {};
  const unjudged: Record<string, string> = {};
  const byModel = new Map<string, { model: Extract<ReturnType<typeof resolveModel<'judgement'>>, { ok: true }>['value']; axes: Axis[] }>();
  for (const axis of axes.value) {
    const model = resolveModel(deps.config, 'judgement', [vault], axis.model);
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
    if (!result.ok) return { ok: false, exitCode: 1, message: `the judgement model ${name} could not answer (${result.error.reason}${'status' in result.error ? ` ${result.error.status}` : ''})` };
    for (const axis of asked) {
      const answer = result.value.answers[axis.name];
      if (answer === undefined) return { ok: false, exitCode: 1, message: `the judgement model ${name} gave no answer for ${axis.name}` };
      answers[axis.name] = answerOf(axis, answer, name, request.questions[axis.name]?.['pass-when'] !== undefined);
    }
  }
  if (Object.keys(answers).length === 0) return { ok: false, exitCode: 3, message: 'no permitted judgement model could answer any question', body: { answers, unjudged } };
  return { ok: true, body: Object.keys(unjudged).length === 0 ? { answers } : { answers, unjudged } };
}

/** The built-in, answering for content of the run's `vault`. */
export function judgeBuiltin(deps: JudgeBuiltinDeps, context: { readonly vault: string }): BuiltinScript {
  return {
    name: 'judge',
    header: {
      summary: 'Ask the judgement models typed questions about given content; advisory, never recorded',
      args: '[--file <path>|scratch:<name>] [--out scratch:<name>] (the request, or a batch, as JSON on standard input otherwise)',
      output: 'json',
      net: true,
    },
    run: async (args, run) => {
      const flags = readArgs(args);
      if (typeof flags === 'string') return output(2, '', `${flags}\n`);
      const scratch = run.env[SCRATCH_VARIABLE];
      const out = flags.out === undefined ? undefined : scratchFile(scratch, flags.out);
      if (flags.out !== undefined && out === undefined) return output(2, '', `usage: --out must name a file in this session's scratch directory (scratch:<name>)\n`);
      const parsed = readRequest(flags.file, run, scratch);
      if (typeof parsed === 'string') return output(2, '', `${parsed}\n`);
      const written = (body: object, summary: string, exitCode: number, stderr = ''): ScriptOutput => {
        if (out === undefined) return output(exitCode, `${JSON.stringify(body)}\n`, stderr);
        writeFileSync(out, `${JSON.stringify(body)}\n`, { mode: 0o600 });
        return output(exitCode, `${summary}\n`, stderr);
      };
      if ('single' in parsed) {
        const judged = await judge(deps, context.vault, parsed.single);
        if (!judged.ok) return output(judged.exitCode, judged.body === undefined ? '' : `${JSON.stringify(judged.body)}\n`, `${judged.message}\n`);
        return written(judged.body, `answered: ${Object.keys(judged.body.answers).length} question(s) → ${flags.out}`, 0);
      }
      const results: Record<string, object> = {};
      let failed = 0;
      for (const { id, request } of parsed.batch) {
        if (typeof request === 'string') {
          results[id] = { error: request };
          failed += 1;
          continue;
        }
        const judged = await judge(deps, context.vault, request);
        results[id] = judged.ok ? judged.body : { error: judged.message };
        if (!judged.ok) failed += 1;
      }
      const summary = `judged ${parsed.batch.length - failed} of ${parsed.batch.length}${failed === 0 ? '' : ` (${failed} failed)`} → ${flags.out}`;
      return written({ results }, summary, failed === 0 ? 0 : 1, failed === 0 ? '' : `${failed} batch entr${failed === 1 ? 'y' : 'ies'} could not be judged\n`);
    },
  };
}
