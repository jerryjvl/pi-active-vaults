// The run file (api.md "Flags", extension.md "Headless sessions"): what the
// daemon tells a headless session it starts — the vault and job document, the
// actor to write as, the run's trace (whose spawn holds its budget), and the
// event that triggered it, which the job receives as structured data.
//
// Read strictly: a headless session runs unattended, so a run file that is not
// exactly right means the run does not happen, rather than running on a guess.

import { EVENT_KINDS } from '../conditions/index.ts';
import { isTraceId } from '../ids/index.ts';
import type { SpawnEvent } from '../queue/index.ts';
import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

export interface RunContext {
  readonly vault: string;
  readonly document: string;
  readonly actor: string;
  readonly trace: string;
  readonly event: SpawnEvent;
}

const KEYS = ['vault', 'document', 'actor', 'trace', 'event'] as const;
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
  const trace = r.string(run['trace'], 'trace');
  if (trace !== '' && !isTraceId(trace)) r.add('trace', 'is not a trace ID');
  const event = r.record(run['event'], 'event');
  r.oneOf(event['kind'], issuePath('event', 'kind'), SPAWN_EVENT_KINDS);
  return r.result({ vault, document, actor, trace, event: event as unknown as SpawnEvent });
}
