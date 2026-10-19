// The judgement role's client: the System One decisions protocol, as served by
// llama.cpp's decision models and TypeSafe (core.md "Judgements").
//
//   POST <url>/systemone  { model, state, questions }  →  { answers, usage? }
//
// One request asks every question about one state. Questions are typed:
// `choice` (named options), `score` (levels, lowest first) and `bool` — which
// the protocol calls `noul` on the wire, both ways. Pi's own System One parser
// was the reference for the wire shapes; nothing of Pi is imported.
//
// Invariants: as for every role (`clients.ts`) — only a `PermittedModel`,
// through `http`, the token only as a bearer token, errors without it. Each
// answer is read in full against its question: present, of the question's
// type, its choice one of the options, probabilities and confidences within
// 0–1 with a choice's probabilities summing to at most 1, a score within the
// levels. Anything else fails the whole request: a gate must never decide on
// a partial or impossible answer. `usage` may be absent.

import { err, isRecord, ok, type Result } from '../result/index.ts';
import { postJson, roleToken, type ModelClient, type ModelError } from './clients.ts';
import type { PermittedModel } from './resolve.ts';

export type SystemOneQuestion =
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }
  | { readonly type: 'bool'; readonly instructions: string; readonly criteria: { readonly true: string; readonly false: string } };

export type SystemOneAnswer =
  | { readonly type: 'choice'; readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number }
  /** `score` is the expected level index, from 0. */
  | { readonly type: 'score'; readonly score: number; readonly confidence: number }
  /** `probability` is that of `true`. */
  | { readonly type: 'bool'; readonly probability: number };

export interface SystemOneRequest {
  /** The data the questions are about; never instructions. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, SystemOneQuestion>>;
}

export interface SystemOneResult {
  readonly answers: Readonly<Record<string, SystemOneAnswer>>;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

// Rounding in a model's softmax should not fail a well-formed answer.
const SUM_TOLERANCE = 1e-6;

const isUnit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** The answer to `question`, or why it cannot be one. */
function readAnswer(question: SystemOneQuestion, given: unknown): SystemOneAnswer | string {
  if (!isRecord(given)) return 'missing';
  switch (question.type) {
    case 'choice': {
      const { choice, probabilities, confidence } = given;
      if (given['type'] !== 'choice') return 'not a choice';
      if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) return 'not one of the options';
      if (!isRecord(probabilities) || !Object.values(probabilities).every(isUnit)) return 'probabilities are not each from 0 to 1';
      if ((Object.values(probabilities) as number[]).reduce((sum, p) => sum + p, 0) > 1 + SUM_TOLERANCE) return 'probabilities sum to more than 1';
      if (!isUnit(confidence)) return 'confidence is not from 0 to 1';
      return { type: 'choice', choice, probabilities: probabilities as Record<string, number>, confidence };
    }
    case 'score': {
      const { score, confidence } = given;
      if (given['type'] !== 'score') return 'not a score';
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.criteria.length - 1) return 'score is outside the levels';
      if (!isUnit(confidence)) return 'confidence is not from 0 to 1';
      return { type: 'score', score, confidence };
    }
    case 'bool':
      if (given['type'] !== 'noul') return 'not a noul';
      return isUnit(given['noul']) ? { type: 'bool', probability: given['noul'] } : 'probability is not from 0 to 1';
  }
}

function readUsage(value: unknown): SystemOneResult['usage'] {
  if (!isRecord(value)) return undefined;
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  return value['input_tokens'] === undefined && value['output_tokens'] === undefined
    ? undefined
    : { inputTokens: count(value['input_tokens']), outputTokens: count(value['output_tokens']) };
}

/** Asks the judgement model every question about the state; every answer, or the request fails. */
export async function askSystemOne(client: ModelClient, model: PermittedModel<'judgement'>, request: SystemOneRequest): Promise<Result<SystemOneResult, ModelError>> {
  const token = await roleToken(client, model);
  if (!token.ok) return token;
  const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, q.type === 'bool' ? { ...q, type: 'noul' } : q]));
  const posted = await postJson(client, model, 'systemone', token.value, { model: model.entry.model, state: request.state, questions });
  if (!posted.ok) return posted;

  const bad = (detail: string): Result<never, ModelError> => err({ reason: 'bad-response', role: model.role, detail });
  const body = posted.value;
  if (!isRecord(body) || !isRecord(body['answers'])) return bad('no answers');
  const given = body['answers'];
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = readAnswer(question, Object.hasOwn(given, name) ? given[name] : undefined);
    if (typeof answer === 'string') return bad(`answer ${name}: ${answer}`);
    answers[name] = answer;
  }
  const usage = readUsage(body['usage']);
  return ok({ answers, ...(usage === undefined ? {} : { usage }) });
}
