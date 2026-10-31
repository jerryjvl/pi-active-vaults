// The one place the package listens or connects: the daemon's local socket
// (daemon.md "Single instance", "Socket protocol") and the signer's
// (signer.md) — each a Unix domain socket, a named pipe on Windows — speaking
// JSON lines, and HTTP endpoints for local clients (http.ts).
//
// Invariants:
//  - a path is bound under one set of rules (bind.ts): one listener holds
//    it, a stale socket is taken over, nothing that is not a socket is
//    removed, and the file is the user's only unless the listener asks for its
//    group too. Only the holder of the daemon's record (queue) may listen on
//    the daemon's socket;
//  - messages are JSON values, one per line (`lineSplitter`), with bounded
//    lines; a line that is not JSON is dropped; a request is answered by its
//    `id`, and anything else on the connection (notices) is left to listeners.

import { randomBytes } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { err, isRecord, lineSplitter, ok, type Result } from '../result/index.ts';
import { bindPath, type ListenError } from './bind.ts';

export type { ListenError } from './bind.ts';
export { listenHttp, type HttpEndpoint, type HttpServer, type HttpServeOptions } from './http.ts';

export interface Channel {
  send(message: unknown): void;
  /** Calls `listener` with each message received, from now on. */
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface SocketServer {
  /** Stops listening, ends open connections and removes the socket file. */
  close(): Promise<void>;
}

export type ConnectError = { readonly reason: 'not-running' } | { readonly reason: 'cannot-connect'; readonly code: string };

export type RequestError =
  | ConnectError
  | { readonly reason: 'no-answer' }
  | { readonly reason: 'refused'; readonly error: unknown };

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

function channelOf(socket: Socket): Channel {
  const listeners: ((message: unknown) => void)[] = [];
  const lines = lineSplitter(MAX_LINE_BYTES, (line) => {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not JSON: nothing anyone could answer
    }
    for (const listener of listeners) listener(message);
  });
  socket.on('data', (chunk: Buffer) => lines.push(chunk));
  socket.on('error', () => socket.destroy());
  return {
    send: (message) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: (listener) => { listeners.push(listener); },
    onClose: (listener) => { socket.on('close', listener); },
    close: () => socket.end(),
  };
}

/** Connects to the socket at `path`; `not-running` when nothing listens there. */
export function connectSocket(path: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Result<Channel, ConnectError>> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(err({ reason: 'cannot-connect', code: 'ETIMEDOUT' }));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(ok(channelOf(socket)));
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const code = error.code ?? 'UNKNOWN';
      resolve(err(code === 'ENOENT' || code === 'ECONNREFUSED' ? { reason: 'not-running' } : { reason: 'cannot-connect', code }));
    });
  });
}

/** Sends one request over `channel` and waits for its answer: the result, or the refusal it carried. */
export function requestOver(channel: Channel, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Result<unknown, RequestError>> {
  const id = randomBytes(8).toString('hex');
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Result<unknown, RequestError>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(err({ reason: 'no-answer' })), timeoutMs);
    channel.onMessage((message) => {
      if (!isRecord(message) || message['id'] !== id) return;
      finish(message['ok'] === true ? ok(message['result']) : err({ reason: 'refused', error: message['error'] }));
    });
    channel.onClose(() => finish(err({ reason: 'no-answer' })));
    channel.send({ id, method, params });
  });
}

/** Connects, asks one thing and disconnects. */
export async function requestOverSocket(path: string, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Result<unknown, RequestError>> {
  const channel = await connectSocket(path);
  if (!channel.ok) return channel;
  try {
    return await requestOver(channel.value, method, params, timeoutMs);
  } finally {
    channel.value.close();
  }
}

/**
 * Listens at `path`, handing each connection to `onChannel`, unless another
 * listener answers there. A socket file nothing answers at is taken over —
 * so the caller must be the only one that may (the daemon holds its record
 * in the state database first).
 */
export async function listenSocket(
  path: string, onChannel: (channel: Channel) => void, access: 'user' | 'group' = 'user',
): Promise<Result<SocketServer, ListenError>> {
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    onChannel(channelOf(socket));
  });

  const failed = await bindPath(server, path, access);
  if (failed !== undefined) return err(failed);

  return ok({
    // Node removes the socket file itself once the server is closed.
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of open) socket.destroy();
    }),
  });
}
