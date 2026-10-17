// JSON requests to configured endpoints: model roles and forges — the one
// place the package makes an HTTP request.
//
// Invariants:
//  - a request goes only to the URL given: redirects are never followed, and
//    one is an error value carrying its status, so neither the body (vault
//    content) nor the credential header is ever resent somewhere else;
//  - every request has a time limit, covering the response body too;
//  - an error value carries a status at most, never the response body, which
//    may echo the request or its credential; the caller adds what the request
//    was for.

import { err, ok, type Result } from '../result/index.ts';

export interface HttpClient {
  readonly fetch: typeof fetch;
  /** Time limit per request; default 60 s. */
  readonly timeoutMs?: number;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  /** The parsed JSON; undefined for an empty body. */
  readonly body: unknown;
}

export type HttpError =
  | { readonly reason: 'unreachable' }
  | { readonly reason: 'timed-out' }
  | { readonly reason: 'redirected'; readonly status: number }
  | { readonly reason: 'http-error'; readonly status: number }
  | { readonly reason: 'bad-response'; readonly detail: string };

const DEFAULT_TIMEOUT_MS = 60_000;

const isTimeout = (error: unknown): boolean => (error as Error | undefined)?.name === 'TimeoutError';

/** Sends one request; a 2xx response with a JSON (or empty) body is the only success. */
export async function requestJson(client: HttpClient, request: HttpRequest): Promise<Result<HttpResponse, HttpError>> {
  let response: Response;
  try {
    response = await client.fetch(request.url, {
      method: request.method,
      headers: { accept: 'application/json', ...(request.body === undefined ? {} : { 'content-type': 'application/json' }), ...request.headers },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(client.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return err(isTimeout(error) ? { reason: 'timed-out' } : { reason: 'unreachable' });
  }
  const { status } = response;
  if (status < 200 || status >= 300) {
    await response.body?.cancel();
    return err(status >= 300 && status < 400 ? { reason: 'redirected', status } : { reason: 'http-error', status });
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return err(isTimeout(error) ? { reason: 'timed-out' } : { reason: 'unreachable' });
  }
  if (text.trim() === '') return ok({ status, body: undefined });
  try {
    return ok({ status, body: JSON.parse(text) as unknown });
  } catch {
    return err({ reason: 'bad-response', detail: 'not JSON' });
  }
}
