// The daemon's local socket (daemon.md "Single instance", "Socket protocol"):
// the one place the package listens or connects — a Unix domain socket in
// the state directory, a named pipe on Windows — speaking JSON lines.
//
// Invariants:
//  - one listener holds the socket: listening where another answers is
//    refused (`in-use`); a socket file left by a listener that has gone is
//    taken over, and nothing that is not a socket is ever removed. Two
//    listeners taking over one stale file at once could both bind, so only
//    the holder of the daemon's record (queue) may listen;
//  - the socket file is the user's only (0600, in the private state
//    directory); a named pipe has the user's default ACL;
//  - messages are JSON values, one per line (`lineSplitter`), with bounded
//    lines; a line that is not JSON is dropped; a request is answered by its
//    `id`, and anything else on the connection (notices) is left to listeners.

import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { err, isRecord, lineSplitter, ok, type Result } from '../result/index.ts';

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

export type ListenError =
  | { readonly reason: 'in-use' }
  | { readonly reason: 'not-a-socket' }
  | { readonly reason: 'path-too-long' }
  | { readonly reason: 'cannot-listen'; readonly code: string };

export type ConnectError = { readonly reason: 'not-running' } | { readonly reason: 'cannot-connect'; readonly code: string };

export type RequestError =
  | ConnectError
  | { readonly reason: 'no-answer' }
  | { readonly reason: 'refused'; readonly error: unknown };

const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** The longest Unix domain socket path every platform accepts (macOS: 104 bytes with its terminator). */
const MAX_UNIX_PATH_BYTES = 103;
const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

function isPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

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

function bind(server: Server, path: string): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const failed = (error: NodeJS.ErrnoException): void => resolve(error);
    server.once('error', failed);
    server.listen(path, () => {
      server.off('error', failed);
      resolve(undefined);
    });
  });
}

/**
 * Listens at `path`, handing each connection to `onChannel`, unless another
 * listener answers there. A socket file nothing answers at is taken over —
 * so the caller must be the only one that may (the daemon holds its record
 * in the state database first).
 */
export async function listenSocket(path: string, onChannel: (channel: Channel) => void): Promise<Result<SocketServer, ListenError>> {
  const pipe = isPipe(path);
  if (!pipe && Buffer.byteLength(path) > MAX_UNIX_PATH_BYTES) return err({ reason: 'path-too-long' });
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    onChannel(channelOf(socket));
  });

  let failed = await bind(server, path);
  if (failed?.code === 'EADDRINUSE' && !pipe) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined && !stat.isSocket()) return err({ reason: 'not-a-socket' });
    const probe = await connectSocket(path);
    if (probe.ok) {
      probe.value.close();
      return err({ reason: 'in-use' });
    }
    // Nothing answers: a socket left by a listener that has gone.
    try {
      unlinkSync(path);
    } catch {
      // Removed meanwhile: binding decides.
    }
    failed = await bind(server, path);
  }
  if (failed !== undefined) return err(failed.code === 'EADDRINUSE' ? { reason: 'in-use' } : { reason: 'cannot-listen', code: failed.code ?? 'UNKNOWN' });
  if (!pipe) chmodSync(path, 0o600);

  return ok({
    // Node removes the socket file itself once the server is closed.
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of open) socket.destroy();
    }),
  });
}
