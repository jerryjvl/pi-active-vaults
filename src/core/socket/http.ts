// HTTP endpoints for local clients (mcp.md "Rules"): a loopback address and
// port, or a local socket path bound under the socket rules (bind.ts). Each
// request is handed to the handler as a web-standard `Request`, and its
// `Response` — a body or a stream — written back.
//
// Invariants:
//  - endpoints do not terminate TLS; exposing one beyond the machine is a
//    reverse proxy's job;
//  - a request body is bounded: past `maxBodyBytes` (declared or sent) the
//    request is answered 413 and never reaches the handler;
//  - a handler that throws is answered 500 with nothing of why, which may
//    carry what the handler held;
//  - closing ends open connections, streams included.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { err, ok, type Result } from '../result/index.ts';
import { bindPath, bindWith, type ListenError } from './bind.ts';

export type HttpEndpoint =
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number }
  /** A Unix domain socket, or a named pipe on Windows. */
  | { readonly kind: 'path'; readonly path: string };

export interface HttpServeOptions {
  readonly maxBodyBytes: number;
}

export interface HttpServer {
  /** `http://<host>:<port>` for an address and port (the port bound, when 0 was asked for); the path for a socket. */
  readonly url: string;
  close(): Promise<void>;
}

type Handler = (request: Request) => Promise<Response>;

class TooLarge extends Error {}

/** The request's body, or TooLarge once it passes `max` bytes. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > max) throw new TooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return headers;
}

function answer(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`${text}\n`);
}

async function respond(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, [...response.headers].flat());
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.once('close', () => void reader.cancel().catch(() => undefined));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function serveOne(handle: Handler, options: HttpServeOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req, options.maxBodyBytes);
  } catch (error) {
    answer(res, error instanceof TooLarge ? 413 : 400, error instanceof TooLarge ? 'Request body too large.' : 'Bad request.');
    return;
  }
  const method = req.method ?? 'GET';
  // The origin is fixed: the Host header is the client's to send, and no decision rests on it here.
  const request = new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method, headers: headersOf(req), ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
  let response: Response;
  try {
    response = await handle(request);
  } catch {
    answer(res, 500, 'Internal error.');
    return;
  }
  try {
    await respond(res, response);
  } catch {
    res.destroy();
  }
}

/** Serves `handle` at `endpoint` until closed. */
export async function listenHttp(endpoint: HttpEndpoint, handle: Handler, options: HttpServeOptions): Promise<Result<HttpServer, ListenError>> {
  const open = new Set<Socket>();
  const server = createServer((req, res) => void serveOne(handle, options, req, res));
  server.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  });
  let url: string;
  if (endpoint.kind === 'path') {
    const failed = await bindPath(server, endpoint.path);
    if (failed !== undefined) return err(failed);
    url = endpoint.path;
  } else {
    // An IPv6 address is written in brackets with its port, and bound without them.
    const host = endpoint.host.replace(/^\[(.*)\]$/, '$1');
    const failed = await bindWith(server, (done) => server.listen(endpoint.port, host, done));
    if (failed !== undefined) return err(failed.code === 'EADDRINUSE' ? { reason: 'in-use' } : { reason: 'cannot-listen', code: failed.code ?? 'UNKNOWN' });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : endpoint.port;
    url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  }
  return ok({
    url,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of open) socket.destroy();
    }),
  });
}
