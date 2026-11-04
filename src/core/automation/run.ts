// Running a spawn (daemon.md "Execution", "Spawn lifecycle"; extension.md
// "Headless sessions"): as `pi --mode rpc` in its actor's worktree, with the
// run file the extension reads (`--vault-run`: vault, document, actor, model,
// trace, event), on the `agent` model the job asks for (`--model`), its Pi
// session named by its trace (`--session-id`), forked from the session that
// triggered it when that session is known and the job allows.
// The headless session is briefed by the extension; the daemon only asks it
// to begin, waits for Pi to settle, and closes its input.
//
// Invariants:
//  - a run starts only on an `agent` model the installation's policy allows
//    for its vault, checked again now rather than trusted from the claim, and
//    only on the model the claim fixed: one that has since gone is not
//    replaced by the default. A spawn with none is stopped `no-model`, before
//    anything of the job is written anywhere;
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
//    request that did not finish — an error, or cut off at the model's output
//    limit (Pi's last assistant `message_end`; models `unfinishedAnswer`) —
//    stop it; a run that settled normally and committed nothing is
//    `no-change`. A model error after commits leaves the run `committed`,
//    and is recorded with its end in the full log;
//  - a run whose job has a `web` block gets the grants the signer issues for
//    it, in its run file (concepts.md "Web grants"). The daemon never signs:
//    it only asks, and a run the signer refuses — or cannot be asked about —
//    runs without grants, its fetches under the web broker's default rules;
//  - each step is in the run's full log (`daemon`; Pi's events in `pi`, its
//    streaming deltas left out), and the run file is removed at the end;
//  - a run leaves its worktree clean: whatever it did not commit is saved to
//    its full log (`uncommitted`) and discarded as it ends, so a run stopped
//    half-way never stops the next one (queue `setAsideUncommitted`);
//  - a run stopped for its budget, its run time, an error, or before it could
//    start (no session, no model, out of date) is told to the vault's owners — once per job and reason within the
//    outbox's cooldown — so a failing job is never silent. A sync conflict is
//    not: the daemon tells owners of those itself (`tellConflicts`).

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRAILER, conflictNotice, ensureActorWorktree, syncActorBranch, trailerValue, uncommittedNotice } from '../actors/index.ts';
import { budgetState } from '../budgets/index.ts';
import { ensurePrivateDir } from '../config/index.ts';
import { commitsBetween, resolveRevision } from '../git/index.ts';
import { requestGrants, type RunGrants } from '../grants/index.ts';
import { acceptedIdentity, requireNoUnacceptedChange, type AcceptedMain } from '../integrity/index.ts';
import { resolveModel, unfinishedAnswer } from '../models/index.ts';
import { packageIdentity, type OperationContext } from '../operations/index.ts';
import { processStartTime, startChild } from '../process/index.ts';
import {
  commitSpawn, forgetRunProcess, noChangeSpawn, recordRunProcess, recordSpawn, setAsideUncommitted, startSpawn, stopSpawn, vaultJobs,
  type SetAside, type SpawnEntry, type StopReason,
} from '../queue/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { renderRunContext } from '../sessions/index.ts';
import { appendFullLog } from '../traces/index.ts';
import { notifyOwners } from './vaults.ts';

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
/** The full log that keeps what a run left uncommitted. */
const UNCOMMITTED_LOG = 'uncommitted';

/**
 * Why a run stopped, as its owners are told. Not told: `requested` (a person
 * asked), `restart` (recovery reports it) and `queue-time` (the queue expires
 * those, never a run).
 */
const STOPPED: Partial<Record<StopReason, string>> = {
  'budget': 'it used its token budget', 'ttl': 'it ran out of time', 'error': 'it failed',
  'no-session': 'the session it needs is not known here', 'no-model': 'it has no model it may use', 'out-of-date': 'its branch could not be brought up to date',
};

/**
 * Tells the vault's owners that a run stopped, or left changes that will stop
 * the next one; nothing for a reason not worth telling. What it says is the
 * package's own account, never the model's, and names the trace for the rest.
 */
async function tellStopped(
  context: OperationContext, vault: RegisteredVault, accepted: AcceptedMain, spawn: SpawnEntry,
  reason: StopReason | undefined, detail: string | undefined, setAside: SetAside = { outcome: 'clean' },
): Promise<void> {
  const why = reason === undefined ? undefined : STOPPED[reason];
  if (why === undefined && setAside.outcome !== 'left') return;
  const lines = [
    why === undefined ? `The run of ${spawn.document} in vault "${vault.id}" left changes it did not commit.` : `The run of ${spawn.document} in vault "${vault.id}" stopped: ${why}.`,
    ...(detail === undefined ? [] : [detail]),
    ...(setAside.outcome === 'reset' ? [`What it had not committed (${setAside.paths.length} file${setAside.paths.length === 1 ? '' : 's'}) is saved in its log, and its worktree was reset, so the next run starts clean.`] : []),
    ...(setAside.outcome === 'left' ? [`Its worktree still holds them, so the next run cannot start: ${setAside.problem}`] : []),
    `Its trace is ${spawn.trace}: "vault trace ${spawn.trace}" shows it while its logs are kept.`,
  ];
  const label = why === undefined ? 'left uncommitted changes' : `stopped (${reason})`;
  await notifyOwners(context, vault, accepted, () => ({
    subject: `Vault "${vault.id}": ${spawn.document} ${label}`, body: `${lines.join('\n\n')}\n`, key: `stopped:${vault.id}:${spawn.document}:${reason ?? 'left'}`,
  }));
}

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

/**
 * The run's web grants, when the installation has a signer and it issues
 * them; otherwise none, with why in the run's log.
 */
async function runGrants(context: OperationContext, vault: string, spawn: SpawnEntry): Promise<RunGrants | undefined> {
  const signer = context.installation.config.webGrants?.signer;
  if (signer === undefined) {
    log(context, spawn.trace, 'daemon', { event: 'no-grants', reason: 'web-grants is not configured' });
    return undefined;
  }
  const asked = await requestGrants(signer, { vault, job: spawn.document, trace: spawn.trace });
  if (!asked.ok) {
    const { error } = asked;
    const reason = error.reason === 'refused' ? error.refusal : error.reason === 'unreachable' ? `the signer did not answer (${error.detail})` : 'the signer\'s answer is not grants';
    log(context, spawn.trace, 'daemon', { event: 'no-grants', reason });
    return undefined;
  }
  log(context, spawn.trace, 'daemon', { event: 'grants', item: asked.value.item !== undefined });
  return asked.value;
}

/** A spawn that never ran: stopped with `reason` and recorded, with why in its log, and told — to its owners too, given its vault's accepted main. */
function never(
  context: OperationContext, spawn: SpawnEntry, reason: StopReason, detail: string, finished: (spawn: SpawnEntry) => void,
  owners?: { readonly vault: RegisteredVault; readonly accepted: AcceptedMain },
): RunHandle {
  const stopped = stopSpawn(context.state, context.clock, spawn.id, reason);
  log(context, spawn.trace, 'daemon', { event: 'not-run', reason, detail });
  const recorded = stopped.ok ? recordSpawn(context.state, spawn.id) : stopped;
  const ended = recorded.ok ? recorded.value : spawn;
  finished(ended);
  const told = owners === undefined ? Promise.resolve() : tellStopped(context, owners.vault, owners.accepted, spawn, reason, detail);
  return { spawn: ended, stop: () => {}, ended: told.then(() => ended) };
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
  const job = jobs.ok ? jobs.value.find((j) => j.path === spawn.document) : undefined;
  const condition = spawn.condition === undefined ? undefined : job?.conditions[spawn.condition];
  const mode = condition?.context ?? 'session-preferred';
  const session = mode === 'bare' ? undefined : originSession(spawn);
  const fork = session === undefined ? undefined : options.sessionFile(session);
  const actor = spawn.actor;
  const owners = { vault, accepted: accepted.value };
  const end = (reason: StopReason, detail: string, told = true): RunHandle => never(context, spawn, reason, detail, hooks.finished, told ? owners : undefined);
  const model = resolveModel(context.installation.config, 'agent', [vault.id], spawn.model);
  if (!model.ok || (spawn.model !== undefined && model.value.name !== spawn.model)) {
    return end('no-model', model.ok ? `its model "${spawn.model ?? ''}" is no longer configured` : `no agent model it may use (${model.error.reason})`);
  }
  if (mode === 'session-required' && fork === undefined) return end('no-session', 'the job requires its originating session, which is not known here');
  const worktree = await ensureActorWorktree(context.git, vault, accepted.value, spawn.actor, context.reads);
  if (!worktree.ok) return end('error', `its actor's worktree cannot be made (${worktree.error.reason})`);
  // A run starts from the accepted main: what the owner changed there since the branch's last
  // accept (a fact corrected by hand) is merged in first, so the run never works on — and then
  // overwrites — a stale copy. A branch that cannot be brought up to date does not run.
  const writer = packageIdentity(context.installation, spawn.actor);
  const synced = await syncActorBranch(
    { git: context.git, store: context.state, alive: context.alive, clock: context.clock, checks: await context.scriptOptions(), attribution: { identity: writer } },
    vault, accepted.value, spawn.actor, { origin: { trace: spawn.trace, actor: spawn.actor }, date: context.clock.now(), identity: writer },
  );
  if (!synced.ok && synced.error.reason === 'sync-conflict') {
    // Only an owner can resolve it: the log says what conflicts and how (the owners are told by the daemon too).
    const identity = await acceptedIdentity(context.reads, context.git, vault.path, accepted.value);
    if (identity.ok) return end('out-of-date', conflictNotice(vault, synced.error.conflict, identity.value.review), false);
  }
  if (synced.ok && synced.value.outcome === 'uncommitted-changes') return end('out-of-date', uncommittedNotice(vault, spawn.actor));
  if (!synced.ok) {
    return end('out-of-date', `its actor's branch could not be brought up to date with the accepted main (${synced.error.reason}); "vault sync ${vault.id} ${spawn.actor}" tries again`);
  }
  const before = await resolveRevision(context.git, worktree.value.path, 'HEAD');
  if (!before.ok) return end('error', 'its actor\'s branch cannot be read');

  const running = startSpawn(context.state, context.clock, spawn.id);
  if (!running.ok) return undefined; // started or stopped meanwhile: not this pass's to run
  const grants = job?.web === undefined ? undefined : await runGrants(context, vault.id, spawn);
  const { runs } = context.installation.paths;
  ensurePrivateDir(runs);
  const runFile = join(runs, `${spawn.trace}.json`);
  writeFileSync(runFile, renderRunContext({
    vault: vault.id, document: spawn.document, actor: spawn.actor, model: model.value.name, trace: spawn.trace, event: spawn.event,
    ...(grants === undefined ? {} : { grants }),
  }), { mode: 0o600 });
  const args = [...options.pi.args, '--mode', 'rpc', '--model', model.value.entry.model, '--vault-run', runFile, '--session-id', spawn.trace, ...(fork === undefined ? [] : ['--fork', fork])];
  const started = await startChild({ program: { file: options.pi.file, args }, cwd: worktree.value.path, env: options.env });
  if (!started.ok) {
    rmSync(runFile, { force: true });
    return end('error', `Pi cannot be started (${started.error.code})`);
  }
  const child = started.value;
  const identity = await processStartTime(child.pid);
  // A process whose start cannot be told is recorded so; recovery then never touches it by ID alone.
  recordRunProcess(context.state, spawn.id, { pid: child.pid, started: identity.ok && identity.value !== undefined ? identity.value : 'unknown' });
  log(context, spawn.trace, 'daemon', { event: 'started', pid: child.pid, cwd: worktree.value.path, model: model.value.name, fork: fork ?? null });
  hooks.started(running.value);

  let stoppedFor: StopReason | undefined;
  let settled = false;
  // Why the last model request did not finish, if it did not: a later answer clears it.
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
    if (answer !== undefined) modelError = unfinishedAnswer(answer);
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
    // Whatever it did not commit is set aside before anything else can start in its worktree.
    const setAside = await setAsideUncommitted({ git: context.git, clock: context.clock, logs: context.installation.paths.logs }, worktree.value.path, actor, spawn.trace, UNCOMMITTED_LOG);
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
      ...(setAside.outcome === 'reset' ? { setAside: setAside.paths } : setAside.outcome === 'left' ? { setAsideProblem: setAside.problem } : {}),
      exitCode: exit.exitCode, signal: exit.signal, stderr: child.stderr(),
    });
    const recorded = outcome.ok ? recordSpawn(context.state, spawn.id) : outcome;
    const final = recorded.ok ? recorded.value : running.value;
    hooks.finished(final);
    const stopped = commit === undefined ? reason : undefined;
    const detail = stopped === 'error' ? modelError ?? `Pi ended with ${exit.exitCode === null ? `signal ${exit.signal ?? 'unknown'}` : `exit code ${exit.exitCode}`}${settled ? '' : ', before it settled'}.` : undefined;
    await tellStopped(context, vault, accepted.value, spawn, stopped, detail, setAside);
    return final;
  });
  return { spawn: running.value, stop: kill, ended };
}

/** The completed assistant message a `message_end` carries, if it carries one. */
function assistantMessage(record: unknown): { stopReason?: unknown; errorMessage?: unknown } | undefined {
  const message = typeof record === 'object' && record !== null ? (record as { message?: unknown }).message : undefined;
  return typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'assistant' ? message : undefined;
}

