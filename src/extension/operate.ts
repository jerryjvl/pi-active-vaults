// Running an operation from a Pi session — for its tools, its `/vault`
// commands and requests on the event bus alike: as the session's caller
// (person, actor, hold, trace, taint), with the notices of any vault it acted
// on that has an unaccepted change, and with what it spawned published.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isRecord } from '../core/result/index.ts';
import { locate, runOperation, unacceptedNotices, type Location, type Operation, type OperationOutcome, type ParamSurface } from '../core/operations/index.ts';
import type { SpawnEntry } from '../core/queue/index.ts';
import type { RegisteredVault } from '../core/registry/index.ts';
import { callerOf, holdForOperation } from '../core/sessions/index.ts';
import type { Live } from './live.ts';

/** The package's channels on Pi's event bus, namespaced and versioned (api.md "Events"). */
export const CHANNEL_PREFIX = 'pav:v1';

/** Tells other packages what spawned work was requested, or how a run ended. */
export function publishSpawns(pi: ExtensionAPI, entries: readonly SpawnEntry[]): void {
  for (const e of entries) {
    pi.events.emit(`${CHANNEL_PREFIX}:spawn`, {
      state: e.state === 'queued' ? 'requested' : e.state, trace: e.trace, vault: e.vault, document: e.document,
      ...(e.parent === undefined ? {} : { parent: e.parent }), ...(e.reason === undefined ? {} : { reason: e.reason }),
    });
  }
}

function spawnsIn(outcome: OperationOutcome): SpawnEntry[] {
  return isRecord(outcome.data) && Array.isArray(outcome.data['spawns']) ? (outcome.data['spawns'] as SpawnEntry[]) : [];
}

export async function operate(
  pi: ExtensionAPI, live: Live, operation: Operation, surface: ParamSurface,
  request: { readonly vaults: readonly RegisteredVault[]; readonly params: Readonly<Record<string, unknown>>; readonly cwd: string },
): Promise<{ outcome: OperationOutcome; notices: string[] }> {
  const { context, session } = live;
  await holdForOperation(context, session, operation.vault, request.vaults);
  const outcome = await runOperation(context, operation, surface, { vaults: request.vaults, params: request.params, caller: callerOf(context, session, request.cwd) });
  publishSpawns(pi, spawnsIn(outcome));
  const notices = (await unacceptedNotices(context, request.vaults)).map((n) => n.notice);
  return { outcome, notices };
}

/** Where a call is made from: the vault the directory is in, else the session's own. */
export function whereOf(live: Live, cwd: string): { here?: Location; fallback?: RegisteredVault } {
  const here = locate(live.context.installation.vaults, cwd);
  return { ...(here === undefined ? {} : { here }), ...(live.session.vault === undefined ? {} : { fallback: live.session.vault }) };
}
