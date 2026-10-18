// Running a spawn (daemon.md "Execution", "Spawn lifecycle"; extension.md
// "Headless sessions"): as `pi --mode rpc` in its actor's worktree, with the
// run file the extension reads (`--vault-run`: vault, document, actor, trace,
// event), its Pi session named by its trace (`--session-id`), forked from the
// session that triggered it when that session is known and the job allows.
// The headless session is briefed by the extension; the daemon only asks it
// to begin, waits for Pi to settle, and closes its input.
//
// Invariants:
//  - nothing runs for a vault whose `main` has an unaccepted change: its work
//    stays queued; a job that requires its originating session (`context:
//    session-required`) and has none to fork is stopped, never run fresh;
//  - the process is recorded — ID and start time — before the run does
//    anything, so start-up recovery can end it by that identity alone;
//  - a run gets its budget's run time and a grace period; past that it is
//    killed;
//  - how it ended is decided from what is recorded, never from what the
//    model says: commits on the actor's branch carrying the run's trace make
//    it `committed`; otherwise its budget record (used up, past its run
//    time), a kill, a stop on request, a failed process, or a last model
//    request that ended in an error (Pi's last assistant `message_end` says
//    `stopReason: error`) stop it; a run that settled normally and committed
//    nothing is `no-change`. A model error after commits leaves the run
//    `committed`, and is recorded with its end in the full log;
//  - each step is in the run's full log (`daemon`; Pi's events in `pi`, its
//    streaming deltas left out), and the run file is removed at the end.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRAILER, ensureActorWorktree, trailerValue } from '../actors/index.ts';
import { budgetState } from '../budgets/index.ts';
import { ensurePrivateDir } from '../config/index.ts';
import { commitsBetween, resolveRevision } from '../git/index.ts';
import { requireNoUnacceptedChange } from '../integrity/index.ts';
import type { OperationContext } from '../operations/index.ts';
import { processStartTime, startChild } from '../process/index.ts';
import {
  commitSpawn, forgetRunProcess, noChangeSpawn, recordRunProcess, recordSpawn, startSpawn, stopSpawn, vaultJobs, type SpawnEntry, type StopReason,
} from '../queue/index.ts';
import { renderRunContext } from '../sessions/index.ts';
import { appendFullLog } from '../traces/index.ts';

export interface PiCommand {
  /** The program, and arguments before the package's own (a launcher, or `node <cli.js>`). */
  readonly file: string;
  readonly args: readonly string[];
}

export interface RunOptions {
  readonly pi: PiCommand;
  /** The environment Pi runs with: the user's own, for Pi's models and settings. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Extra time past its run time before a run is killed. */
  readonly graceMs: number;
  /** The session file of a Pi session, by its ID, when it is known here (it asked to be told of its spawns). */
  readonly sessionFile: (session: string) => string | undefined;
}

export interface RunHandle {
  readonly spawn: SpawnEntry;
  /** Stops the run: it is killed and recorded as stopped with `reason`. */
  stop(reason: StopReason): void;
  /** The spawn as recorded once the run has ended. */
  readonly ended: Promise<SpawnEntry>;
}

/** What the prompt asks; the job itself is the run's brief, from its accepted main. */
const BEGIN = 'Begin the job you were briefed with.';
const LOGGED_EVENT_SKIPPED = new Set(['message_update', 'tool_execution_update']);

function log(context: OperationContext, trace: string, name: string, record: Readonly<Record<string, unknown>>): void {
  appendFullLog(context.installation.paths.logs, context.clock, trace, name, { at: context.clock.now().toISOString(), ...record });
}

/** The Pi session the spawn's event came from, when it came from one. */
function originSession(spawn: SpawnEntry): string | undefined {
  const { event } = spawn;
  if ('session' in event && typeof event.session === 'string') return event.session;
  if (event.kind.startsWith('session.') && 'id' in event) return event.id.split('/')[0];
  return undefined;
}

/** A spawn that never ran: stopped with `reason` and recorded, with why in its log, and told. */
function never(context: OperationContext, spawn: SpawnEntry, reason: StopReason, detail: string, finished: (spawn: SpawnEntry) => void): RunHandle {
  const stopped = stopSpawn(context.state, context.clock, spawn.id, reason);
  log(context, spawn.trace, 'daemon', { event: 'not-run', reason, detail });
  const recorded = stopped.ok ? recordSpawn(context.state, spawn.id) : stopped;
  const ended = recorded.ok ? recorded.value : spawn;
  finished(ended);
  return { spawn: ended, stop: () => {}, ended: Promise.resolve(ended) };
}

/**
 * Starts `spawn` if it can run now: undefined when it must wait (its vault is
 * paused, or it is no longer queued); otherwise a handle, whose `ended` says
 * how the run ended. `started` and `finished` are called as it does.
 */
export async function startRun(
  context: OperationContext, options: RunOptions, spawn: SpawnEntry,
  hooks: { readonly started: (spawn: SpawnEntry) => void; readonly finished: (spawn: SpawnEntry) => void },
): Promise<RunHandle | undefined> {
  const vault = context.installation.vaults.find((v) => v.id === spawn.vault);
  if (vault === undefined || spawn.actor === undefined) {
    return never(context, spawn, 'error', vault === undefined ? 'its vault is not registered' : 'it has no actor', hooks.finished);
  }
  const accepted = await requireNoUnacceptedChange(context.git, context.state, vault);
  if (!accepted.ok) return undefined;
  const jobs = await vaultJobs(context.git, vault.path, accepted.value, context.reads);
  const condition = spawn.condition === undefined || !jobs.ok ? undefined : jobs.value.find((j) => j.path === spawn.document)?.conditions[spawn.condition];
  const mode = condition?.context ?? 'session-preferred';
  const session = mode === 'bare' ? undefined : originSession(spawn);
  const fork = session === undefined ? undefined : options.sessionFile(session);
  const end = (reason: StopReason, detail: string): RunHandle => never(context, spawn, reason, detail, hooks.finished);
  if (mode === 'session-required' && fork === undefined) return end('no-session', 'the job requires its originating session, which is not known here');
  const worktree = await ensureActorWorktree(context.git, vault, accepted.value, spawn.actor, context.reads);
  if (!worktree.ok) return end('error', `its actor's worktree cannot be made (${worktree.error.reason})`);
  const before = await resolveRevision(context.git, worktree.value.path, 'HEAD');
  if (!before.ok) return end('error', 'its actor\'s branch cannot be read');

  const running = startSpawn(context.state, context.clock, spawn.id);
  if (!running.ok) return undefined; // started or stopped meanwhile: not this pass's to run
  const { runs } = context.installation.paths;
  ensurePrivateDir(runs);
  const runFile = join(runs, `${spawn.trace}.json`);
  writeFileSync(runFile, renderRunContext({ vault: vault.id, document: spawn.document, actor: spawn.actor, trace: spawn.trace, event: spawn.event }), { mode: 0o600 });
  const args = [...options.pi.args, '--mode', 'rpc', '--vault-run', runFile, '--session-id', spawn.trace, ...(fork === undefined ? [] : ['--fork', fork])];
  const started = await startChild({ program: { file: options.pi.file, args }, cwd: worktree.value.path, env: options.env });
  if (!started.ok) {
    rmSync(runFile, { force: true });
    return end('error', `Pi cannot be started (${started.error.code})`);
  }
  const child = started.value;
  const identity = await processStartTime(child.pid);
  // A process whose start cannot be told is recorded so; recovery then never touches it by ID alone.
  recordRunProcess(context.state, spawn.id, { pid: child.pid, started: identity.ok && identity.value !== undefined ? identity.value : 'unknown' });
  log(context, spawn.trace, 'daemon', { event: 'started', pid: child.pid, cwd: worktree.value.path, fork: fork ?? null });
  hooks.started(running.value);

  let stoppedFor: StopReason | undefined;
  let settled = false;
  // The last model request's error, if it ended in one: a later answer clears it.
  let modelError: string | undefined;
  child.onLine((line) => {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const type = typeof record === 'object' && record !== null ? (record as { type?: unknown }).type : undefined;
    if (typeof type === 'string' && LOGGED_EVENT_SKIPPED.has(type)) return;
    log(context, spawn.trace, 'pi', { record });
    const answer = type === 'message_end' ? assistantMessage(record) : undefined;
    if (answer !== undefined) modelError = modelErrorOf(answer);
    if (type === 'agent_settled' && !settled) {
      settled = true;
      child.endInput();
      setTimeout(() => child.kill(), options.graceMs).unref();
    }
  });
  const kill = (reason: StopReason): void => {
    stoppedFor ??= reason;
    child.kill();
  };
  const budget = budgetState(context.state, context.installation.config.budgets, context.clock, spawn.trace);
  const ttl = budget?.deadline === undefined ? 0 : Date.parse(budget.deadline) - context.clock.now().getTime();
  const deadline = setTimeout(() => kill('ttl'), Math.max(0, ttl) + options.graceMs);
  child.write(`${JSON.stringify({ id: 'begin', type: 'prompt', message: BEGIN })}\n`);

  const ended = child.exited.then(async (exit) => {
    clearTimeout(deadline);
    rmSync(runFile, { force: true });
    const ours = await commitsBetween(context.git, worktree.value.path, before.value, 'HEAD');
    const commit = ours.ok ? ours.value.filter((c) => trailerValue(c, TRAILER.trace) === spawn.trace).at(-1)?.sha : undefined;
    const state = budgetState(context.state, context.installation.config.budgets, context.clock, spawn.trace);
    const reason: StopReason | undefined = stoppedFor
      ?? (state?.exhausted === true || state?.dailyExhausted === true ? 'budget' : state?.overTime === true ? 'ttl' : undefined)
      ?? (exit.exitCode !== 0 || !settled || modelError !== undefined ? 'error' : undefined);
    const outcome = commit !== undefined ? commitSpawn(context.state, context.clock, spawn.id, commit)
      : reason !== undefined ? stopSpawn(context.state, context.clock, spawn.id, reason)
      : noChangeSpawn(context.state, context.clock, spawn.id);
    forgetRunProcess(context.state, spawn.id);
    log(context, spawn.trace, 'daemon', {
      event: 'ended', outcome: outcome.ok ? outcome.value.state : 'unrecorded', ...(commit === undefined ? {} : { commit }),
      ...(commit === undefined && reason !== undefined ? { reason } : {}), ...(modelError === undefined ? {} : { modelError }),
      exitCode: exit.exitCode, signal: exit.signal, stderr: child.stderr(),
    });
    const recorded = outcome.ok ? recordSpawn(context.state, spawn.id) : outcome;
    const final = recorded.ok ? recorded.value : running.value;
    hooks.finished(final);
    return final;
  });
  return { spawn: running.value, stop: kill, ended };
}

/** The completed assistant message a `message_end` carries, if it carries one. */
function assistantMessage(record: unknown): { stopReason?: unknown; errorMessage?: unknown } | undefined {
  const message = typeof record === 'object' && record !== null ? (record as { message?: unknown }).message : undefined;
  return typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'assistant' ? message : undefined;
}

/** Why the model request behind `answer` failed, or undefined when it ended normally. */
function modelErrorOf(answer: { stopReason?: unknown; errorMessage?: unknown }): string | undefined {
  if (answer.stopReason !== 'error') return undefined;
  return typeof answer.errorMessage === 'string' && answer.errorMessage !== '' ? answer.errorMessage : 'the model request failed';
}

