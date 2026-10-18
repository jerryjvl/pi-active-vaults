// Documented behaviour: api.md "Events" and pi-conventions.md "Inter-package
// conventions" — the extension publishes on `pi.events`, namespaced `pav:v1:`:
// `ready` after `session_start` with its version and capabilities, `event`
// for each session event as matched against conditions, `spawn` as spawned
// work is requested; and answers `pav:v1:request` for `ping`, `search`,
// `contract` and `status` on `pav:v1:reply:<id>`. Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { withInstallation } from '../support/installation.ts';
import { openPi } from '../support/pi.ts';
import { RUNNING } from '../support/session.ts';

/** Asks the extension over the event bus, as another package would, through a bus handle taken from the session's extensions. */
async function ask(events: ExtensionAPI['events'], method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; status?: string; data?: unknown; text?: string }> {
  const id = `req-${method}`;
  const reply = new Promise<unknown>((resolve) => { const off = events.on(`pav:v1:reply:${id}`, (data) => { off(); resolve(data); }); });
  events.emit('pav:v1:request', { id, method, params });
  return (await reply) as { ok: boolean };
}

test('ready says the version and capabilities once the session has started', withInstallation(async (t) => {
  const pi = await openPi(t);
  try {
    const ready = pi.events.filter((e) => e.channel === 'pav:v1:ready').map((e) => e.data as { version: string; capabilities: string[] });
    assert.equal(ready.length, 1);
    assert.match(ready[0]?.version ?? '', /^\d+\.\d+\.\d+/);
    assert.deepEqual(ready[0]?.capabilities, ['ping', 'search', 'contract', 'status']);
  } finally {
    await pi.shutdown();
  }
}, { running: RUNNING }));

test('requests on the bus are answered on the reply channel; an unknown method is refused', withInstallation(async (t) => {
  let bus: ExtensionAPI['events'] | undefined;
  const pi = await openPi(t, { extra: (api) => { bus = api.events; } });
  try {
    assert.ok(bus !== undefined);
    assert.deepEqual((await ask(bus, 'ping')).ok, true);
    const contract = await ask(bus, 'contract', { path: 'home:notes/a.md' });
    assert.equal(contract.status, 'ok');
    assert.match(contract.text ?? '', /Root prose\./);
    assert.equal((await ask(bus, 'status')).status, 'ok');
    assert.equal((await ask(bus, 'accept', { actor: 'gardener' })).ok, false, 'owner acts are not offered on the bus');
  } finally {
    await pi.shutdown();
  }
}, { running: RUNNING }));
