// Clients for the model roles' HTTP APIs (concepts.md "Installation"):
//   embed     — OpenAI-compatible POST <url>/embeddings
//   rerank    — POST <url>/rerank, Jina / Cohere style
//   judgement — POST <url>/systemone (see `systemone.ts`)
// The configured `url` is the API base (`…/v1`).
//
// Invariants: a client accepts only a `PermittedModel`, so the installation's
// policy has been applied; requests go through `http`, so a redirect is an
// error and content goes only to the configured URL; the token is resolved at
// the point of use, once per call, and sent only as a bearer token; error
// values name the role and a reason — never the token, and never the response
// body, which may echo either; a response is checked in full (one finite
// vector or score per input, vectors of one dimension), and anything else is
// an error, never a partial result.

import { resolveSecret, type ModelRole, type SecretDeps } from '../config/index.ts';
import { requestJson, type HttpClient, type HttpError } from '../http/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { inBatches } from './batches.ts';
import type { PermittedModel } from './roles.ts';

export interface ModelClient extends HttpClient {
  readonly secrets: SecretDeps;
}

export type ModelError =
  | { readonly reason: 'token'; readonly role: ModelRole; readonly where: string }
  | (HttpError & { readonly role: ModelRole });

/** The role's API at `path`, under the configured base URL. */
function apiUrl(model: PermittedModel, path: string): string {
  return `${model.endpoint.url.replace(/\/+$/, '')}/${path}`;
}

/** POSTs `body` as JSON to the role's API with its bearer token; the response's JSON, or why not. */
export async function postJson(client: ModelClient, model: PermittedModel, path: string, token: string, body: unknown): Promise<Result<unknown, ModelError>> {
  const posted = await requestJson(client, { method: 'POST', url: apiUrl(model, path), headers: { authorization: `Bearer ${token}` }, body });
  return posted.ok ? ok(posted.value.body) : err({ ...posted.error, role: model.role });
}

/** The role's token, resolved now; an error names only the config field. */
export async function roleToken(client: ModelClient, model: PermittedModel): Promise<Result<string, ModelError>> {
  const token = await resolveSecret(model.endpoint.token, client.secrets);
  return token.ok ? token : err({ reason: 'token', role: model.role, where: token.error.where });
}

/** Resolves the token once, then sends the inputs in batches. */
async function batched<I, O>(
  client: ModelClient, model: PermittedModel, inputs: readonly I[],
  send: (token: string, batch: readonly I[]) => Promise<Result<readonly O[], ModelError>>,
): Promise<Result<O[], ModelError>> {
  if (inputs.length === 0) return ok([]);
  const token = await roleToken(client, model);
  if (!token.ok) return token;
  return inBatches(inputs, model.endpoint, (batch) => send(token.value, batch));
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Places each `{ index, … }` item of a response at its index; every index must appear exactly once. */
function byIndex<T>(items: unknown, count: number, read: (item: Record<string, unknown>) => T | undefined): T[] | string {
  if (!Array.isArray(items) || items.length !== count) return `expected ${count} results`;
  const placed: (T | undefined)[] = new Array(count);
  for (const item of items) {
    if (typeof item !== 'object' || item === null) return 'a result is not an object';
    const { index } = item as { index?: unknown };
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || placed[index] !== undefined) {
      return 'result indexes do not match the inputs';
    }
    const value = read(item as Record<string, unknown>);
    if (value === undefined) return 'a result has the wrong shape';
    placed[index] = value;
  }
  return placed as T[];
}

/** One vector per text, in the texts' order. */
export async function embed(client: ModelClient, model: PermittedModel<'embed'>, texts: readonly string[]): Promise<Result<number[][], ModelError>> {
  const vectors = await batched<string, number[]>(client, model, texts, async (token, batch) => {
    const posted = await postJson(client, model, 'embeddings', token, { model: model.endpoint.model, input: batch });
    if (!posted.ok) return posted;
    const placed = byIndex((posted.value as { data?: unknown } | null)?.data, batch.length, (item) => {
      const embedding = item['embedding'];
      return Array.isArray(embedding) && embedding.length > 0 && embedding.every(isFiniteNumber) ? embedding : undefined;
    });
    return typeof placed === 'string' ? err({ reason: 'bad-response', role: model.role, detail: placed }) : ok(placed);
  });
  if (!vectors.ok) return vectors;
  const dimension = vectors.value[0]?.length;
  if (vectors.value.some((v) => v.length !== dimension)) return err({ reason: 'bad-response', role: model.role, detail: 'vectors differ in dimension' });
  return vectors;
}

/** A relevance score for each document against the query, in the documents' order. */
export async function rerank(client: ModelClient, model: PermittedModel<'rerank'>, query: string, documents: readonly string[]): Promise<Result<number[], ModelError>> {
  return batched<string, number>(client, model, documents, async (token, batch) => {
    const posted = await postJson(client, model, 'rerank', token, { model: model.endpoint.model, query, documents: batch, top_n: batch.length });
    if (!posted.ok) return posted;
    const placed = byIndex((posted.value as { results?: unknown } | null)?.results, batch.length, (item) =>
      isFiniteNumber(item['relevance_score']) ? item['relevance_score'] : undefined);
    return typeof placed === 'string' ? err({ reason: 'bad-response', role: model.role, detail: placed }) : ok(placed);
  });
}
