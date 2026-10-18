// A link to the running daemon (extension.md "Session lifecycle", "Spawns";
// architecture.md "Process model"): what a Pi session — or any surface —
// uses to send spawn requests to the daemon and hear of its spawns, through
// the socket protocol. Optional by design: with no daemon, there is no link,
// and requests are queued in the state database instead (principle 15).
//
// Sending: a claim the daemon made is returned; no answer throws, so the
// caller queues the request under its fixed identity and finds the claim the
// daemon may have made (`submitSpawns`); a refusal returns nothing, and the
// request is queued here, where the daemon finds it.

import type { SpawnEntry, SpawnRequest, SpawnSender } from '../queue/index.ts';
import { connectSocket, requestOver, type Channel } from '../socket/index.ts';
import { isRecord } from '../result/index.ts';
import type { Notice } from './protocol.ts';

export interface DaemonLink {
  readonly send: SpawnSender;
  /** Asks to be told of the spawns in the tree of the session with `trace`; `file` lets them fork it. */
  subscribe(trace: string, session: { readonly id: string; readonly file?: string }, onNotice: (notice: Notice) => void): Promise<boolean>;
  close(): void;
}

/** How long a surface waits for a daemon to answer before working without one. */
const LINK_TIMEOUT_MS = 1000;

/** The link to the daemon at `socket`, if one runs and answers. */
export async function linkDaemon(socket: string): Promise<DaemonLink | undefined> {
  const connected = await connectSocket(socket, LINK_TIMEOUT_MS);
  if (!connected.ok) return undefined;
  const channel: Channel = connected.value;
  const ping = await requestOver(channel, 'ping', {}, LINK_TIMEOUT_MS);
  if (!ping.ok) {
    channel.close();
    return undefined;
  }
  const listeners: ((notice: Notice) => void)[] = [];
  channel.onMessage((message) => {
    if (!isRecord(message) || message['notice'] !== 'spawn') return;
    const { notice: _kind, ...notice } = message;
    for (const listener of listeners) listener(notice as unknown as Notice);
  });
  return {
    send: async (request: SpawnRequest) => {
      const sent = await requestOver(channel, 'spawn', request);
      if (sent.ok) return sent.value as SpawnEntry;
      if (sent.error.reason === 'refused') return undefined;
      throw new Error(`the daemon did not answer (${sent.error.reason})`);
    },
    async subscribe(trace, session, onNotice) {
      listeners.push(onNotice);
      const asked = await requestOver(channel, 'subscribe', { trace, session: session.id, ...(session.file === undefined ? {} : { file: session.file }) });
      return asked.ok;
    },
    close: () => channel.close(),
  };
}
