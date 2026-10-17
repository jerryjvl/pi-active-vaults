// Clients for the model roles' HTTP APIs (concepts.md "Installation"):
//   embed  — OpenAI-compatible POST <url>/embeddings
//   rerank — POST <url>/rerank, Jina / Cohere style
// The configured `url` is the API base (`…/v1`).
//
// Invariants: a client accepts only a `PermittedModel`, so the installation's
// policy has been applied; the token is resolved at the point of use, once per
// call, and sent only as a bearer token; error values name the role and a
// reason — never the token, and never the response body, which may echo
// either; a response is checked in full (one finite vector or score per
// input, vectors of one dimension), and anything else is an error, never a
// partial result.

import { resolveSecret, type ModelRole, type SecretDeps } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { inBatches } from './batches.ts';
import type { PermittedModel } from './roles.ts';

export interface ModelClient {
  readonly fetch: typeof fetch;
  readonly secrets: SecretDeps;
  /** Time limit per request; default 60 s. */
  readonly timeoutMs?: number;
}

export type ModelError =
  | { readonly reason: 'token'; readonly role: ModelRole; readonly where: string }
  | { readonly reason: 'unreachable'; readonly role: ModelRole }
  | { readonly reason: 'timed-out'; readonly role: ModelRole }
  | { readonly reason: 'http-error'; readonly role: ModelRole; readonly status: number }
  | { readonly reason: 'bad-response'; readonly role: ModelRole; readonly detail: string };

const DEFAULT_TIMEOUT_MS = 60_000;

function apiUrl(model: PermittedModel, path: string): string {
  return `${model.endpoint.url.replace(/\/+$/, '')}/${path}`;
}

async function postJson(client: ModelClient, model: PermittedModel, path: string, token: string, body: unknown): Promise<Result<unknown, ModelError>> {
  const { role } = model;
  let response: Response;
  try {
    response = await client.fetch(apiUrl(model, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(client.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return err((error as Error).name === 'TimeoutError' ? { reason: 'timed-out', role } : { reason: 'unreachable', role });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return err({ reason: 'http-error', role, status: response.status });
  }
  try {
    return ok(await response.json());
  } catch (error) {
    return err((error as Error).name === 'TimeoutError' ? { reason: 'timed-out', role } : { reason: 'bad-response', role, detail: 'not JSON' });
  }
}

/** Resolves the token once, then sends the inputs in batches. */
async function batched<I, O>(
  client: ModelClient, model: PermittedModel, inputs: readonly I[],
  send: (token: string, batch: readonly I[]) => Promise<Result<readonly O[], ModelError>>,
): Promise<Result<O[], ModelError>> {
  if (inputs.length === 0) return ok([]);
  const token = await resolveSecret(model.endpoint.token, client.secrets);
  if (!token.ok) return err({ reason: 'token', role: model.role, where: token.error.where });
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
