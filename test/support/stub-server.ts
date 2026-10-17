// Local HTTP stub for model endpoints and forges. Tests never use the network;
// a stub speaks the same HTTP shapes as the real service and records requests.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | object;
}

export type StubHandler = (request: RecordedRequest) => StubResponse | Promise<StubResponse>;

export interface StubServer {
  /** Base URL, e.g. http://127.0.0.1:41234 */
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** The handler decides every response; one that throws yields a 500 so the test fails visibly. */
export async function startStubServer(handler: StubHandler): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    void respond(req, res);
  });

  async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(recorded);
    try {
      const { status = 200, headers = {}, body = '' } = await handler(recorded);
      const isObject = typeof body === 'object';
      res.writeHead(status, isObject ? { 'content-type': 'application/json', ...headers } : headers);
      res.end(isObject ? JSON.stringify(body) : body);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
