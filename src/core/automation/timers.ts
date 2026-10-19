// Timers (daemon.md "Timers"): each minute, every timer condition of every
// job in a hosted, unpaused vault is asked which of its slots came due since
// its cursor (`timerFirings`): each due slot is a spawn, identified by the
// job and the slot — its local date and time — so it is claimed once
// whatever the clocks do. A condition's script narrows a firing as it narrows
// any match.
//
// A tick knows the previous tick's slot only while the daemon has kept
// running; at start, after the process was suspended, and for a vault that
// was paused, earlier slots were missed, and `missed` decides about them.

import { localSlot, narrowByScripts, parseSchedule, timerFirings, type Slot } from '../conditions/index.ts';
import { acceptedMain } from '../integrity/index.ts';
import { queueContext, type OperationContext } from '../operations/index.ts';
import { advanceCursor, enqueueSpawn, readCursor, scriptFilters, timerStream, vaultJobs, type SpawnMatching } from '../queue/index.ts';
import type { RegisteredVault } from '../registry/index.ts';

export interface TimerTickState {
  readonly now: Date;
  readonly timeZone: string;
  /** The previous tick's slot, while the daemon has kept running. */
  readonly previous?: Slot;
  /** Vaults just out of a pause: what they missed counts as missed. */
  readonly resumed: ReadonlySet<string>;
}

/** Claims the timer runs that came due in hosted, unpaused vaults, and moves their cursors. */
export async function tickTimers(
  context: OperationContext, matching: SpawnMatching, hosted: readonly RegisteredVault[], paused: ReadonlySet<string>, tick: TimerTickState,
): Promise<void> {
  const now = localSlot(tick.now, tick.timeZone);
  for (const vault of hosted) {
    if (paused.has(vault.id)) continue; // its cursors wait, so what it misses meanwhile is missed, not lost
    const accepted = acceptedMain(context.state, vault.id);
    const jobs = accepted === undefined ? undefined : await vaultJobs(context.git, vault.path, accepted, context.reads);
    for (const job of jobs?.ok === true ? jobs.value : []) {
      if (job.terms === undefined) continue;
      for (const [index, condition] of job.conditions.entries()) {
        if (condition.on !== 'timer' || condition.effect !== 'spawn' || condition.schedule === undefined) continue;
        const schedule = parseSchedule(condition.schedule);
        if (!schedule.ok) continue; // conditions are checked when read; a schedule that is not one never fires
        const key = { vault: vault.id, document: job.path, stream: timerStream(index) };
        const cursor = readCursor(context.state, key);
        const previous = tick.resumed.has(vault.id) ? undefined : tick.previous;
        const firing = timerFirings(schedule.value, condition.missed ?? 'run-once', { now, ...(cursor === undefined ? {} : { cursor }), ...(previous === undefined ? {} : { previous }) });
        for (const at of firing.fire) {
          const event = { kind: 'timer' as const, at };
          const match = { vault: vault.id, document: job.path, index, condition };
          const narrowed = await narrowByScripts(scriptFilters(matching), matching.scripts, event, [match]);
          if (narrowed.kept.length === 0) continue;
          enqueueSpawn(context.state, queueContext(context), { vault: vault.id, document: job.path, condition: index, event, ...job.terms });
        }
        if (firing.advanceTo !== cursor) advanceCursor(context.state, context.clock, key, cursor ?? null, firing.advanceTo);
      }
    }
  }
}
