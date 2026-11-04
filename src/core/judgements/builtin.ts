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
//  - a model that cannot answer is asked once more; if it still cannot, its
//    questions are reported unjudged with why, and the other models' answers
//    stand — nothing is guessed, and a caller treats an unjudged question as
//    not passed, so keeping the rest never lets anything through.
//
// Input (standard input, or `--file <path>` — relative to the run's directory,
// or `scratch:<name>` in the session's scratch directory):
//   { "state": <object or text>, "questions": { <name>: <axis> } }
// Output: { "answers": { <name>: <answer> & { model, passed?, level? } },
//           "unjudged"?: { <name>: <reason> } }
// Exit: 0 answered, 1 a model failed (the output says which questions), 2 usage,
// 3 no permitted model for any question.
//
// A batch asks many at once: { "questions"?: <shared>, "batch": [{ "id", "state",
// "questions"? }] } (an entry's own questions replace the shared ones), and
// answers { "results": { <id>: <output> | { "error": <why> } } }; one entry's
// failure does not stop the others. The exit is 0 when every entry was fully
// answered, 4 when no entry got any answer, and 1 otherwise. The output is
// written in every case, so a caller can keep what was judged.
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
  | { readonly ok: true; readonly body: { answers: Record<string, Record<string, unknown>>; unjudged?: Record<string, string> }; readonly failed?: string }
  | { readonly ok: false; readonly exitCode: number; readonly message: string; readonly body?: object };

/** How many times a judgement model is asked before its questions are left unjudged: a second chance for a passing fault. */
const ATTEMPTS = 2;

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
  // Why the first model that failed could not answer, for the summary.
  let failed: string | undefined;
  for (const [name, { model, axes: asked }] of byModel) {
    const questions = Object.fromEntries(asked.map((a) => [a.name, a.question]));
    let result = await askSystemOne(deps.client, model, { state: request.state, questions });
    for (let attempt = 1; !result.ok && attempt < ATTEMPTS; attempt++) result = await askSystemOne(deps.client, model, { state: request.state, questions });
    if (!result.ok) {
      const why = `the judgement model ${name} could not answer (${result.error.reason}${'status' in result.error ? ` ${result.error.status}` : ''})`;
      failed ??= why;
      for (const axis of asked) unjudged[axis.name] = why;
      continue;
    }
    for (const axis of asked) {
      const answer = result.value.answers[axis.name];
      if (answer === undefined) {
        const why = `the judgement model ${name} gave no answer for ${axis.name}`;
        failed ??= why;
        unjudged[axis.name] = why;
      } else answers[axis.name] = answerOf(axis, answer, name, request.questions[axis.name]?.['pass-when'] !== undefined);
    }
  }
  const body = Object.keys(unjudged).length === 0 ? { answers } : { answers, unjudged };
  if (Object.keys(answers).length === 0 && failed === undefined) return { ok: false, exitCode: 3, message: 'no permitted judgement model could answer any question', body };
  return { ok: true, body, ...(failed === undefined ? {} : { failed }) };
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
        const unjudged = Object.keys(judged.body.unjudged ?? {}).length;
        return written(judged.body, `answered: ${Object.keys(judged.body.answers).length} question(s)${unjudged === 0 ? '' : `, ${unjudged} unjudged`} → ${flags.out}`, judged.failed === undefined ? 0 : 1, judged.failed === undefined ? '' : `${judged.failed}\n`);
      }
      const results: Record<string, object> = {};
      // Entries not fully answered, and those with no answer at all.
      let failed = 0;
      let unanswered = 0;
      for (const { id, request } of parsed.batch) {
        const judged = typeof request === 'string' ? { ok: false as const, message: request } : await judge(deps, context.vault, request);
        results[id] = judged.ok ? judged.body : { error: judged.message };
        if (!judged.ok || judged.failed !== undefined) failed += 1;
        if (!judged.ok || Object.keys(judged.body.answers).length === 0) unanswered += 1;
      }
      const total = parsed.batch.length;
      const summary = `judged ${total - failed} of ${total}${failed === 0 ? '' : ` (${failed} not fully)`} → ${flags.out}`;
      const exitCode = failed === 0 ? 0 : unanswered === total ? 4 : 1;
      return written({ results }, summary, exitCode, failed === 0 ? '' : `${failed} batch entr${failed === 1 ? 'y' : 'ies'} could not be fully judged${exitCode === 4 ? ', none at all' : ''}\n`);
    },
  };
}
