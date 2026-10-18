// Budget records per turn (extension.md "Session lifecycle", concepts.md
// "Session tree", principle 7): each turn's work is recorded against the
// session's budget as the turn ends — one transaction — so a crash loses at
// most the turn in progress.
//
// A headless run is stopped once its allotment or the day's ceiling is used,
// or its run time is past. An interactive session is the person's: its work
// counts towards the day, so it limits what is spawned, but it is not stopped.

import { accountUsage, budgetState, type BudgetState, type RequestUsage } from '../budgets/index.ts';
import type { OperationContext } from '../operations/index.ts';
import type { VaultSession } from './session.ts';

/** Why a headless run must stop; the daemon records it as the spawn's stop reason. */
export type TurnStop = 'budget' | 'ttl';

export interface TurnRecord {
  /** Absent when the session has no budget to record against (none was allotted). */
  readonly state?: BudgetState;
  readonly stop?: TurnStop;
}

/** Records one turn — every request it made, the model's and its tools' — and says whether the run must stop. */
export function recordTurn(context: OperationContext, session: VaultSession, usages: readonly RequestUsage[]): TurnRecord {
  const turn = usages.reduce<RequestUsage>(
    (sum, u) => ({ prompt: sum.prompt + u.prompt, cachedPrefix: sum.cachedPrefix + u.cachedPrefix, generated: sum.generated + u.generated }),
    { prompt: 0, cachedPrefix: 0, generated: 0 },
  );
  const recorded = context.state.transaction((tx) => accountUsage(tx, context.installation.config.budgets, context.clock, session.trace, turn));
  if (!recorded.ok) return {};
  const state = recorded.value;
  if (session.mode === 'interactive') return { state };
  if (state.exhausted || state.dailyExhausted) return { state, stop: 'budget' };
  return state.overTime ? { state, stop: 'ttl' } : { state };
}

/** The tokens a headless run may still use — none once its budget, the day's ceiling or its run time is spent; undefined for an interactive session, which is not bounded so. */
export function workLeft(context: OperationContext, session: VaultSession): number | undefined {
  if (session.mode === 'interactive') return undefined;
  const state = budgetState(context.state, context.installation.config.budgets, context.clock, session.trace);
  if (state === undefined || state.dailyExhausted || state.overTime) return 0;
  return state.remaining;
}
