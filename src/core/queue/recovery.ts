// Start-up recovery (daemon.md "Start-up recovery"): only one daemon runs,
// so nothing it started can still be legitimately running when it starts —
// or when `vault doctor --fix` acts with no daemon running. Its state goes
// back to a clean slate:
//
//  1. each headless session left from a previous run is ended by the exact
//     process recorded, only after its start time is checked (`endProcess`),
//     never by name;
//  2. every running spawn is stopped with the reason `restart`, which ends
//     its budget session, and its actor's hold by that run is released;
//  3. the worktree of each actor those spawns held goes back to the actor's
//     last commit, its uncommitted changes saved to the run's full log first;
//  4. queued spawns stay queued, keeping their queue-time limit.
//
// Interactive Pi sessions are not the daemon's: their holds stay valid while
// their processes live. A worktree that is not on its actor's branch is left
// as it is — resetting the wrong checkout would lose someone's work.
//
// Setting a worktree's uncommitted changes aside (`setAsideUncommitted`) is
// also what a run does when it ends (automation `startRun`), so what a run
// left half-done never blocks the next: the changes go to the run's full log,
// rotated with it (`logs.keep-days`), and only then is the worktree reset.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { actorBranch, actorWorktreePath, releaseActorHold } from '../actors/index.ts';
import type { Clock } from '../clock/index.ts';
import { currentBranch, discardUncommitted, uncommittedDiff, uncommittedPaths, type Git } from '../git/index.ts';
import { endProcess, type ProcessLiveness } from '../process/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import type { Store } from '../store/index.ts';
import { appendFullLog } from '../traces/index.ts';
import { forgetRunProcess, runProcesses } from './runs.ts';
import { listSpawns, stopSpawn, type SpawnEntry } from './spawns.ts';

export interface RecoveryDeps {
  readonly git: Git;
  readonly store: Store;
  readonly alive: ProcessLiveness;
  readonly clock: Clock;
  /** The full-log directory. */
  readonly logs: string;
  readonly vaults: readonly RegisteredVault[];
}

export interface RecoveryReport {
  /** Process IDs ended. */
  readonly ended: number[];
  /** Spawns stopped with the reason `restart`. */
  readonly stopped: number[];
  /** Worktrees returned to their last commit. */
  readonly reset: string[];
  /** What could not be done, with why. */
  readonly problems: string[];
}

/** The log a recovery writes into the run's full log. */
const RECOVERY_LOG = 'recovery';

export interface SetAsideDeps {
  readonly git: Git;
  readonly clock: Clock;
  /** The full-log directory. */
  readonly logs: string;
}

/** What setting a worktree's changes aside did: nothing to do, the paths saved and discarded, or why it was left as it is. */
export type SetAside = { readonly outcome: 'clean' } | { readonly outcome: 'reset'; readonly paths: readonly string[] } | { readonly outcome: 'left'; readonly problem: string };
const MAX_SAVED_FILE = 64 * 1024;
const MAX_SAVED_TOTAL = 1024 * 1024;
/** How long an ended process may take to disappear before its worktree is reset anyway. */
const GONE_CHECKS = 100;
const GONE_CHECK_MS = 20;

async function untilGone(pid: number, alive: ProcessLiveness): Promise<void> {
  for (let i = 0; i < GONE_CHECKS; i++) {
    const now = await alive(pid);
    if (now.ok && now.value === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, GONE_CHECK_MS));
  }
}

/** The untracked files' text, bounded, so the log keeps what reset would lose. */
function untrackedText(worktree: string, paths: readonly string[], tracked: string): { path: string; text: string; cut?: true }[] {
  let total = 0;
  return paths.filter((p) => !tracked.includes(`b/${p}`)).flatMap((path) => {
    try {
      const file = join(worktree, ...path.split('/'));
      if (!statSync(file).isFile() || total >= MAX_SAVED_TOTAL) return [];
      const bytes = readFileSync(file).subarray(0, Math.min(MAX_SAVED_FILE, MAX_SAVED_TOTAL - total));
      total += bytes.length;
      return [{ path, text: bytes.toString('utf8'), ...(bytes.length < statSync(file).size ? { cut: true as const } : {}) }];
    } catch {
      return [];
    }
  });
}

/**
 * Saves the uncommitted changes in `actor`'s worktree to `trace`'s full log
 * (as `log`), then returns the worktree to its last commit. A worktree not on
 * the actor's branch, or whose changes cannot be read or saved, is left as it
 * is: changes are never thrown away unsaved.
 */
export async function setAsideUncommitted(deps: SetAsideDeps, worktree: string, actor: string, trace: string, log: string): Promise<SetAside> {
  const branch = await currentBranch(deps.git, worktree);
  if (!branch.ok || branch.value !== actorBranch(actor)) return { outcome: 'left', problem: `${worktree} is not on ${actorBranch(actor)}; it was left as it is.` };
  const paths = await uncommittedPaths(deps.git, worktree);
  const diff = await uncommittedDiff(deps.git, worktree);
  if (!paths.ok || !diff.ok) return { outcome: 'left', problem: `The changes in ${worktree} could not be read, so it was left as it is.` };
  if (paths.value.length === 0) return { outcome: 'clean' };
  const saved = appendFullLog(deps.logs, deps.clock, trace, log, {
    at: deps.clock.now().toISOString(), worktree, paths: paths.value, diff: diff.value, untracked: untrackedText(worktree, paths.value, diff.value),
  });
  if (!saved.ok) return { outcome: 'left', problem: `The changes in ${worktree} could not be saved to the run's log, so it was left as it is.` };
  const discarded = await discardUncommitted(deps.git, worktree);
  return discarded.ok ? { outcome: 'reset', paths: paths.value } : { outcome: 'left', problem: `${worktree} could not be reset (${discarded.error.reason}).` };
}

async function resetWorktree(deps: RecoveryDeps, spawn: SpawnEntry, report: RecoveryReport): Promise<void> {
  const vault = deps.vaults.find((v) => v.id === spawn.vault);
  if (vault === undefined || spawn.actor === undefined) return;
  const worktree = actorWorktreePath(vault, spawn.actor);
  const done = await setAsideUncommitted(deps, worktree, spawn.actor, spawn.trace, RECOVERY_LOG);
  if (done.outcome === 'reset') report.reset.push(worktree);
  else if (done.outcome === 'left') report.problems.push(done.problem);
}

/** Returns the daemon's state to a clean slate; what it did is reported. */
export async function recoverRuns(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = { ended: [], stopped: [], reset: [], problems: [] };
  const runs = new Map(runProcesses(deps.store).map((run) => [run.spawn, run]));
  for (const run of runs.values()) {
    const outcome = await endProcess(run, deps.alive);
    if (outcome === 'ended') {
      report.ended.push(run.pid);
      await untilGone(run.pid, deps.alive);
    } else if (outcome === 'cannot-tell') {
      report.problems.push(`Process ${run.pid} exists, but whether it is the run recorded cannot be told; it was not touched.`);
    }
  }
  const reset = new Set<string>();
  for (const spawn of listSpawns(deps.store, { states: ['running'] })) {
    const stopped = stopSpawn(deps.store, deps.clock, spawn.id, 'restart');
    if (stopped.ok) report.stopped.push(spawn.id);
    const run = runs.get(spawn.id);
    if (run !== undefined && spawn.actor !== undefined) {
      // A headless session holds its actor as its own process, under the run's trace.
      releaseActorHold(deps.store, { vault: spawn.vault, actor: spawn.actor, holder: { process: { pid: run.pid, started: run.started }, session: spawn.trace } });
    }
    const key = `${spawn.vault}\0${spawn.actor ?? ''}`;
    if (!reset.has(key)) {
      reset.add(key);
      await resetWorktree(deps, spawn, report);
    }
  }
  for (const spawn of runs.keys()) forgetRunProcess(deps.store, spawn);
  return report;
}
