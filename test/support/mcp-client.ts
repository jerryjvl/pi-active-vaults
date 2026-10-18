// A minimal MCP client for tests, speaking JSON-RPC by hand so the tests check
// the wire rather than the SDK's view of it: the 2025-era handshake
// (`initialize`, then requests), over HTTP — a JSON or server-sent-events
// answer — and over standard input/output as JSON lines.

import { request as httpRequest } from 'node:http';
import type { Readable, Writable } from 'node:stream';

export const PROTOCOL_VERSION = '2025-06-18';

export const INITIALIZE = {
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pav-test', version: '0' } },
} as const;

export interface RpcAnswer {
  readonly status: number;
  /** The JSON-RPC messages in the answer. */
  readonly messages: Record<string, unknown>[];
  readonly text: string;
}

/** The messages in a response body: one JSON value, or the `data:` lines of an event stream. */
function messagesIn(text: string, contentType: string): Record<string, unknown>[] {
  if (contentType.includes('text/event-stream')) {
    return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)) as Record<string, unknown>);
  }
  if (text.trim() === '') return [];
  try {
    const value = JSON.parse(text) as unknown;
    return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/** POSTs one message to an MCP endpoint — a URL, or `{ socketPath }` for one on a socket. */
export function post(
  where: string | { readonly socketPath: string }, message: unknown, headers: Record<string, string> = {}, raw?: string,
): Promise<RpcAnswer> {
  const body = raw ?? JSON.stringify(message);
  const target = typeof where === 'string' ? new URL(where) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      method: 'POST',
      ...(target === undefined ? { socketPath: (where as { socketPath: string }).socketPath, path: '/mcp' } : { host: target.hostname, port: target.port, path: target.pathname }),
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION,
        'content-length': String(Buffer.byteLength(body)), ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, text, messages: messagesIn(text, String(res.headers['content-type'] ?? '')) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A JSON-lines MCP client over a pair of streams: send requests, await each answer by ID. */
export function stdioClient(toServer: Writable, fromServer: Readable): { request(method: string, params?: unknown): Promise<Record<string, unknown>>; notify(method: string): void } {
  let buffer = '';
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  fromServer.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message['id'] === 'number') waiting.get(message['id'])?.(message);
    }
  });
  let next = 1;
  return {
    request(method, params = {}) {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        toServer.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method) {
      toServer.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
  };
}
