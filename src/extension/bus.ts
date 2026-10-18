// Requests from other packages on Pi's event bus (api.md "Events",
// pi-conventions.md "Inter-package conventions"): `pav:v1:request` carries
// `{ id, method, params }`, and the answer goes to `pav:v1:reply:<id>`. The
// methods are `ping` and the reading operations `search`, `contract` and
// `status`; nothing that writes or acts as an owner is offered, since any
// package in the session can ask.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { callRequest, describeCommandLineError, operationNamed, outcomeData } from '../core/operations/index.ts';
import { isRecord } from '../core/result/index.ts';
import { liveOr, type Holder } from './live.ts';
import { operate, CHANNEL_PREFIX, whereOf } from './operate.ts';

/** The methods answered, in the order `ready` lists them. */
export const BUS_METHODS = ['ping', 'search', 'contract', 'status'] as const;

async function answer(pi: ExtensionAPI, holder: Holder, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (method === 'ping') return { ok: true };
  const operation = (BUS_METHODS as readonly string[]).includes(method) ? operationNamed(method) : undefined;
  if (operation === undefined) return { ok: false, error: `"${method}" is not offered here; ask for one of ${BUS_METHODS.join(', ')}.` };
  const found = liveOr(holder);
  if ('problem' in found) return { ok: false, error: found.problem };
  const { live } = found;
  const surface = operation.surfaces.tool !== undefined ? 'tool' : 'command';
  const request = callRequest(live.context.installation, operation, surface, params, whereOf(live, live.cwd));
  if (!request.ok) return { ok: false, error: describeCommandLineError(request.error, operation, 'tool') };
  const { outcome, notices } = await operate(pi, live, operation, surface, { ...request.value, cwd: live.cwd });
  return { ok: true, ...outcomeData(outcome, notices) };
}

/** Answers requests until the returned function is called. */
export function subscribeRequests(pi: ExtensionAPI, holder: Holder): () => void {
  return pi.events.on(`${CHANNEL_PREFIX}:request`, (data) => {
    if (!isRecord(data) || typeof data['id'] !== 'string' || typeof data['method'] !== 'string') return;
    const { id, method } = data;
    const params = isRecord(data['params']) ? data['params'] : {};
    void answer(pi, holder, method, params).then(
      (reply) => pi.events.emit(`${CHANNEL_PREFIX}:reply:${id}`, reply),
      (error: unknown) => pi.events.emit(`${CHANNEL_PREFIX}:reply:${id}`, { ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}
