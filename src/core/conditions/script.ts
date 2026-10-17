// A condition's `script`: the precise escape hatch for what the other fields
// cannot say (concepts.md "applies-when").
//
// It runs only for a match — after every other field has matched — and can
// only narrow it: the spawn happens only if the script exits 0. So what a
// condition can match is still known from its other fields. The script is one
// of the document's own vault's scripts, run through `scripts` like every
// other run: from the accepted `main`, refused while `main` has an unaccepted
// change, with the event as JSON on standard input. Anything short of a clean
// exit 0 — a missing script, a refusal, a time-out — drops the match (fail
// closed), with the reason, so the caller can report it.

import { runScript, type ScriptRunOptions } from '../scripts/index.ts';
import type { Git } from '../git/index.ts';
import type { VaultLocation } from '../integrity/index.ts';
import type { Queryable } from '../store/index.ts';
import { eventJson, type Match, type VaultEvent } from './match.ts';

export interface ScriptFilterContext {
  readonly git: Git;
  readonly store: Queryable;
  /** Where a registered vault is; undefined for one this installation does not know. */
  readonly locate: (vault: string) => VaultLocation | undefined;
}

/** How filter scripts run; each runs in its own vault's directory. */
export type ScriptFilterOptions = Omit<ScriptRunOptions, 'kind' | 'cwd' | 'input'>;

export interface Narrowed {
  readonly kept: Match[];
  readonly dropped: { readonly match: Match; readonly reason: string }[];
}

/** Runs the script of each match that has one, in order; keeps those that exit 0 and every match without a script. */
export async function narrowByScripts(
  context: ScriptFilterContext, options: ScriptFilterOptions, event: VaultEvent, matches: readonly Match[],
): Promise<Narrowed> {
  const narrowed: Narrowed = { kept: [], dropped: [] };
  const input = eventJson(event);
  for (const match of matches) {
    const { script } = match.condition;
    if (script === undefined) {
      narrowed.kept.push(match);
      continue;
    }
    const vault = context.locate(match.vault);
    if (vault === undefined) {
      narrowed.dropped.push({ match, reason: 'unknown-vault' });
      continue;
    }
    const ran = await runScript({ git: context.git, store: context.store, vault }, script, [], { ...options, kind: 'script', cwd: vault.path, input });
    const reason = !ran.ok ? ran.error.reason : ran.value.timedOut ? 'timed-out' : ran.value.exitCode === 0 ? undefined : `exit ${ran.value.exitCode}`;
    if (reason === undefined) narrowed.kept.push(match);
    else narrowed.dropped.push({ match, reason });
  }
  return narrowed;
}
