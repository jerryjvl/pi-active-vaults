// Notification spools (notifications.md "Spools"): each tick, every spool the
// installation's `notify.spools` names is read, and its messages go to the
// outbox for that spool's alias (notify/spool.ts) — before the outbox's
// retries, so a message sent now is not tried twice in one tick.
//
// Invariants: a spool sends at most `spoolAllowance` notifications an hour;
// what each sent is remembered only while the daemon runs, so a restart
// grants a fresh hour (the installation's own hourly limit still holds). The
// latest pass of each spool is kept for `daemon status`.

import { drainSpool, spoolAllowance } from '../notify/index.ts';
import { notifyDeps, scriptEnvironment, type OperationContext } from '../operations/index.ts';
import { newTraceId } from '../traces/index.ts';

const HOUR_MS = 3_600_000;

export interface SpoolStatus {
  readonly alias: string;
  readonly directory: string;
  readonly at: string;
  /** Messages sent in the last hour. */
  readonly sentLastHour: number;
  /** Messages waiting for the next pass (the hour's limit). */
  readonly waiting: number;
  /** Messages rejected by the latest pass. */
  readonly rejected: number;
  readonly error?: string;
}

export interface Spools {
  tick(): Promise<void>;
  outcomes(): SpoolStatus[];
}

export function createSpools(context: OperationContext): Spools {
  const sentAt = new Map<string, number[]>();
  const outcomes = new Map<string, SpoolStatus>();

  return {
    async tick() {
      const deps = notifyDeps(context, scriptEnvironment(context.installation));
      const spools = Object.entries(deps?.config.spools ?? {});
      if (deps === undefined || spools.length === 0) return;
      const now = context.clock.now().getTime();
      for (const [alias, directory] of spools) {
        const recent = (sentAt.get(alias) ?? []).filter((t) => now - t < HOUR_MS);
        const allowance = Math.max(0, spoolAllowance(deps.config.limits.perHour) - recent.length);
        const pass = await drainSpool(deps, alias, directory, () => newTraceId(context.ids), allowance);
        for (const sent of pass.sent) if (sent.outcome !== 'duplicate') recent.push(now);
        sentAt.set(alias, recent);
        outcomes.set(alias, {
          alias, directory, at: new Date(now).toISOString(), sentLastHour: recent.length, waiting: pass.waiting, rejected: pass.rejected.length,
          ...(pass.error === undefined ? {} : { error: pass.error }),
        });
      }
    },
    outcomes: () => [...outcomes.values()],
  };
}
