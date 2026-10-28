// A session's trace (concepts.md "Trace", extension.md "Session lifecycle"):
// what its compact record says — its trigger, the causal path of runs that
// led to it, its session, the scripts it ran and, for other vaults it worked
// in, only opaque references — and its full detail on the machine: the
// session's start, each tool result, each turn's work and its end, as JSON
// lines in the trace's `session` log.
//
// Invariants: the record is assembled from what the session and the budget
// ledger know, never from what a model says; another vault is never named in
// a vault's record (principle 12); a log line is bounded, so one huge tool
// result cannot fill the disk, and says when it was cut. Full logs are the
// machine's and may hold anything a tool returned; nothing here is sent
// anywhere.

import { budgetState, treePath } from '../budgets/index.ts';
import type { OperationContext } from '../operations/index.ts';
import { isRecord } from '../result/index.ts';
import { appendFullLog, opaqueReference, type RunRecord, type TraceTrigger } from '../traces/index.ts';
import type { VaultSession } from './session.ts';

/** The full log a session writes. */
const SESSION_LOG = 'session';
/** The most text one log line keeps of a tool result. */
const MAX_LOGGED_TEXT = 256 * 1024;

export interface ToolResult {
  readonly tool: string;
  readonly input: unknown;
  readonly isError: boolean;
  /** The result as text, as the model saw it. */
  readonly text: string;
  /** The structured result, when the tool gave one (`{ status, data, text, notices }` for vault tools). */
  readonly data?: unknown;
}

/** Appends one record to the session's full log; a log that cannot be written loses detail, never the session. */
export function logSession(context: OperationContext, session: VaultSession, record: Readonly<Record<string, unknown>>): void {
  appendFullLog(context.installation.paths.logs, context.clock, session.trace, SESSION_LOG, {
    at: context.clock.now().toISOString(), session: session.id, ...record,
  });
}

/** A vault script's run, from `vault_script`'s structured result: its name, vault and exit status. */
function scriptRun(session: VaultSession, result: ToolResult): VaultSession['scripts'][number] | undefined {
  if (result.tool !== 'vault_script' || !isRecord(result.data) || !isRecord(result.data['data'])) return undefined;
  const ran = result.data['data'];
  const name = typeof ran['name'] === 'string' ? ran['name'] : isRecord(result.input) && typeof result.input['name'] === 'string' ? result.input['name'] : undefined;
  const vault = typeof ran['vault'] === 'string' ? ran['vault'] : session.vault?.id;
  const exitCode = typeof ran['exitCode'] === 'number' ? ran['exitCode'] : ran['exitCode'] === null ? null : undefined;
  return name === undefined || vault === undefined || exitCode === undefined ? undefined : { vault, name, exitCode };
}

/** Records a tool's result in the full log, and a script it ran for the compact record. */
export function logToolResult(context: OperationContext, session: VaultSession, result: ToolResult): void {
  const truncated = result.text.length > MAX_LOGGED_TEXT;
  logSession(context, session, {
    kind: 'tool', tool: result.tool, input: result.input, isError: result.isError,
    text: truncated ? result.text.slice(0, MAX_LOGGED_TEXT) : result.text, ...(truncated ? { truncated: true } : {}),
  });
  const script = scriptRun(session, result);
  if (script !== undefined) session.scripts.push(script);
}

/**
 * A fan-out item's answer, or why it has none, beside its tool calls: the
 * evidence a failure is examined by after the scratch directory has gone.
 */
export function logItemOutcome(context: OperationContext, session: VaultSession, outcome: { index: number; item: string; outcome: string; text: string; workspace?: string }): void {
  const truncated = outcome.text.length > MAX_LOGGED_TEXT;
  logSession(context, session, {
    kind: 'item', item: outcome.index, label: outcome.item.slice(0, 200), outcome: outcome.outcome, ...(outcome.workspace === undefined ? {} : { workspace: outcome.workspace }),
    text: truncated ? outcome.text.slice(0, MAX_LOGGED_TEXT) : outcome.text, ...(truncated ? { truncated: true } : {}),
  });
}

/** What started the session: a headless run's event and job, or the interactive session itself. */
function triggerOf(session: VaultSession): TraceTrigger {
  const run = session.run;
  if (run === undefined) return { event: 'session.start' };
  const { event } = run;
  return {
    event: event.kind,
    document: run.document,
    ...('commit' in event ? { commit: event.commit } : {}),
    ...(event.kind === 'external' ? { name: event.name } : {}),
    ...(event.kind === 'timer' ? { at: event.at } : {}),
  };
}

/** The session's compact record for `vault` as it stands, but for the documents its commits produce. */
export function traceRecord(context: OperationContext, session: VaultSession, vault: string): RunRecord {
  const budget = budgetState(context.state, context.installation.config.budgets, context.clock, session.trace);
  const elsewhere = [...session.touched].filter((v) => v !== vault).map((v) => opaqueReference(session.trace, v)).sort();
  return {
    trace: session.trace,
    vault,
    path: treePath(context.state, session.trace),
    trigger: triggerOf(session),
    sessions: [{
      actor: session.actor ?? context.installation.config.person ?? 'unknown',
      session: session.id,
      started: session.started,
      tokens: budget?.used ?? 0,
      // The record travels with the run's commits; how the run ends is its spawn's state and its full log.
      outcome: 'committed',
    }],
    judgements: [],
    scripts: session.scripts.filter((s) => s.vault === vault).map(({ name, exitCode }) => ({ name, exitCode })),
    elsewhere,
  };
}
