// Binding a listener to a local path — a Unix domain socket, or a named pipe
// on Windows — for every server the socket module runs (its JSON-lines
// socket, its HTTP endpoints), so each follows the same rules:
//  - a path where another listener answers is refused (`in-use`);
//  - a socket file nothing answers at, left by a listener that has gone, is
//    taken over; nothing that is not a socket is ever removed. Two listeners
//    taking over one stale file at once could both bind, so a caller must be
//    the only one that may listen there;
//  - the socket file is the user's only (0600); a named pipe has the user's
//    default ACL.

import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createConnection, type Server } from 'node:net';

export type ListenError =
  | { readonly reason: 'in-use' }
  | { readonly reason: 'not-a-socket' }
  | { readonly reason: 'path-too-long' }
  | { readonly reason: 'cannot-listen'; readonly code: string };

/** The longest Unix domain socket path every platform accepts (macOS: 104 bytes with its terminator). */
const MAX_UNIX_PATH_BYTES = 103;
const PROBE_TIMEOUT_MS = 2000;

export function isPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

/** Listens with `server` where `listen` says; the error, if it could not. */
export function bindWith(server: Server, listen: (done: () => void) => void): Promise<NodeJS.ErrnoException | undefined> {
  return new Promise((resolve) => {
    const failed = (error: NodeJS.ErrnoException): void => resolve(error);
    server.once('error', failed);
    listen(() => {
      server.off('error', failed);
      resolve(undefined);
    });
  });
}

/** Whether something answers at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const done = (answered: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Binds `server` to the local `path` under the rules above. */
export async function bindPath(server: Server, path: string): Promise<ListenError | undefined> {
  const pipe = isPipe(path);
  if (!pipe && Buffer.byteLength(path) > MAX_UNIX_PATH_BYTES) return { reason: 'path-too-long' };
  const bind = (): Promise<NodeJS.ErrnoException | undefined> => bindWith(server, (done) => server.listen(path, done));
  let failed = await bind();
  if (failed?.code === 'EADDRINUSE' && !pipe) {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      stat = undefined;
    }
    if (stat !== undefined && !stat.isSocket()) return { reason: 'not-a-socket' };
    if (await answers(path)) return { reason: 'in-use' };
    // Nothing answers: a socket left by a listener that has gone.
    try {
      unlinkSync(path);
    } catch {
      // Removed meanwhile: binding decides.
    }
    failed = await bind();
  }
  if (failed !== undefined) return failed.code === 'EADDRINUSE' ? { reason: 'in-use' } : { reason: 'cannot-listen', code: failed.code ?? 'UNKNOWN' };
  if (!pipe) chmodSync(path, 0o600);
  return undefined;
}
