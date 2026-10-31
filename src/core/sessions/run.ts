// The run file (api.md "Flags", extension.md "Headless sessions"): what the
// daemon tells a headless session it starts — the vault and job document, the
// actor to write as, the `agent` model it was started on (by configured name),
// the run's trace (whose spawn holds its budget), the event that triggered
// it, which the job receives as structured data, and the run's web grants
// when the signer issued any (concepts.md "Web grants").
//
// Read strictly: a headless session runs unattended, so a run file that is not
// exactly right means the run does not happen, rather than running on a guess.

import { EVENT_KINDS } from '../conditions/index.ts';
import { MODEL_NAME } from '../config/index.ts';
import { isTraceId } from '../ids/index.ts';
import { parseRunGrants, type RunGrants } from '../grants/index.ts';
import type { SpawnEvent } from '../queue/index.ts';
import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

export interface RunContext {
  readonly vault: string;
  readonly document: string;
  readonly actor: string;
  /** The `agent` model the daemon started it with, by its name in the installation. */
  readonly model: string;
  readonly trace: string;
  readonly event: SpawnEvent;
  /** Its web grants: the script grant its scripts get, and the item grant its fan-out items' MCP servers get. */
  readonly grants?: RunGrants;
}

const KEYS = ['vault', 'document', 'actor', 'model', 'trace', 'event', 'grants'] as const;
/** Every event a spawn can answer: the conditions' events, and a manual run. */
const SPAWN_EVENT_KINDS = [...EVENT_KINDS, 'manual'] as const;

export function renderRunContext(run: RunContext): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

export function parseRunContext(text: string): Result<RunContext, Issue[]> {
  const r = new DataReader();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    r.add('', 'is not JSON');
    return r.result(undefined as unknown as RunContext);
  }
  const run = r.record(value, '', KEYS);
  const vault = r.string(run['vault'], 'vault');
  const document = r.string(run['document'], 'document');
  const actor = r.string(run['actor'], 'actor');
  const model = r.string(run['model'], 'model', MODEL_NAME);
  const trace = r.string(run['trace'], 'trace');
  if (trace !== '' && !isTraceId(trace)) r.add('trace', 'is not a trace ID');
  const event = r.record(run['event'], 'event');
  r.oneOf(event['kind'], issuePath('event', 'kind'), SPAWN_EVENT_KINDS);
  const grants = run['grants'] === undefined ? undefined : parseRunGrants(run['grants']);
  if (grants?.ok === false) r.issues.push(...grants.error);
  return r.result({ vault, document, actor, model, trace, event: event as unknown as SpawnEvent, ...(grants?.ok === true ? { grants: grants.value } : {}) });
}
