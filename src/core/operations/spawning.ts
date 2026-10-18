// Requesting spawns on this installation (extension.md "Spawns", daemon.md
// "Spawn lifecycle"): an event matched against the jobs of the vaults it reaches, and
// each match sent to the daemon or queued under its fixed identity — the one
// way `vault trigger`, commits and Pi sessions request work — and how what
// became of the requests is told.

import type { VaultEvent } from '../conditions/index.ts';
import type { GitError } from '../git/index.ts';
import { matchSpawns, reachedVaults, submitSpawns, type MatchedSpawns, type QueueContext, type SpawnEntry, type SpawnMatching } from '../queue/index.ts';
import type { Result } from '../result/index.ts';
import type { OperationContext } from './context.ts';

/** What claiming a spawn needs: IDs for its trace, the clock, and the installation's budget limits. */
export function queueContext(context: OperationContext): QueueContext {
  return { ids: context.ids, clock: context.clock, limits: context.installation.config.budgets };
}

/** How this installation matches events to spawns: its vaults, their accepted mains read once, its subscriptions and label equivalences, and how condition scripts run. */
export async function spawnMatching(context: OperationContext): Promise<SpawnMatching> {
  const { config, vaults } = context.installation;
  return {
    git: context.git, store: context.state, vaults, reads: context.reads,
    match: { subscriptions: config.subscriptions, equivalentLabels: config.labels.equivalent },
    scripts: { ...(await context.scriptOptions()), builtins: [] },
  };
}

export interface RequestedSpawns {
  readonly entries: readonly SpawnEntry[];
  readonly matched: MatchedSpawns;
}

/**
 * The spawns `event` requests: matched in the vaults it reaches — from
 * `event.vault`'s, or every vault for a session-wide event — in the tree of
 * `parent` when given, then sent to the daemon when one runs (`context.send`)
 * or queued.
 */
export async function requestSpawns(
  context: OperationContext, given: { readonly event: VaultEvent; readonly id?: string },
  tree: { readonly parent?: string } = {},
): Promise<Result<RequestedSpawns, GitError>> {
  const { config, vaults } = context.installation;
  const from = 'vault' in given.event ? given.event.vault : undefined;
  const matched = await matchSpawns(await spawnMatching(context), given, reachedVaults(vaults, config.subscriptions, from), tree);
  if (!matched.ok) return matched;
  const entries = await submitSpawns(context.state, queueContext(context), matched.value.requests, context.send);
  return { ok: true, value: { entries, matched: matched.value } };
}

/** What became of each spawn requested, and of the matches that requested none, for a person or model. */
export function spawnLines(entries: readonly SpawnEntry[], matched: Pick<MatchedSpawns, 'dropped' | 'paused'>): string[] {
  return [
    ...entries.map((e) => (e.state === 'queued'
      ? `Queued ${e.vault}:${e.document} as trace ${e.trace}; the daemon runs it.`
      : `${e.vault}:${e.document} was not queued: ${e.reason ?? e.state}.`)),
    ...matched.dropped.map((d) => `${d.vault}:${d.document}: its script did not match (${d.reason}).`),
    ...matched.paused.map((id) => `Vault "${id}" is paused (unaccepted change); its jobs were not matched.`),
  ];
}
