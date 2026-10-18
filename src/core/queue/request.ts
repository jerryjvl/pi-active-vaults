// From an event to spawns (concepts.md "applies-when", extension.md
// "Spawns", daemon.md "Claims"): matching an event against the jobs of the
// vaults it reaches, then sending each request to the daemon or queueing it.
// `vault trigger`, Pi sessions and their commits use this, as the daemon will.
//
// Invariants:
//  - jobs, their conditions and their scripts come from each vault's accepted
//    `main`; a vault with an unaccepted change is paused — reported, never
//    matched — because a spawn is a propagating action (security.md);
//  - a request's identity — document and event, with the event's ID fixed by
//    the caller before anything is sent — is decided before it is sent or
//    queued, so a request the daemon claimed and that was also queued after a
//    lost reply is one spawn: the claim is a unique insert;
//  - only spawn conditions spawn, only jobs with a budget and an actor, and
//    a condition's script only narrows; a request writes as the job's actor.

import type { Budget } from '../budgets/index.ts';
import { isGitEvent, matchConditions, narrowByScripts, type Candidate, type MatchContext, type ScriptFilterOptions, type VaultEvent } from '../conditions/index.ts';
import type { Git, GitError } from '../git/index.ts';
import { requireNoUnacceptedChange } from '../integrity/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { vaultJobs } from './jobs.ts';
import { enqueueSpawn, type QueueContext, type SpawnEntry, type SpawnEvent, type SpawnRequest } from './spawns.ts';

export interface SpawnMatching {
  readonly git: Git;
  readonly store: Store;
  /** Every registered vault, so a filter script can be found in its own. */
  readonly vaults: readonly RegisteredVault[];
  readonly match: MatchContext;
  readonly scripts: ScriptFilterOptions;
}

export interface MatchedSpawns {
  readonly requests: readonly SpawnRequest[];
  /** Matches a condition's script turned down, with why. */
  readonly dropped: readonly { readonly vault: string; readonly document: string; readonly reason: string }[];
  /** Vaults not matched because their `main` has an unaccepted change (or cannot be read). */
  readonly paused: readonly string[];
}

/** Sends a request to the daemon: the claim it made, or undefined when no daemon took it. */
export type SpawnSender = (request: SpawnRequest) => Promise<SpawnEntry | undefined>;

/** The vaults an event reaches: its own and those the installation subscribes to it; a session-wide event, every vault. */
export function reachedVaults(
  vaults: readonly RegisteredVault[], subscriptions: MatchContext['subscriptions'], from: string | undefined,
): RegisteredVault[] {
  if (from === undefined) return [...vaults];
  const subscribers = subscriptions.filter((s) => s.from === from).map((s) => s.to);
  return vaults.filter((v) => v.id === from || subscribers.includes(v.id));
}

/** The event as a spawn sees it: a Git event is its own identity; any other carries the ID it was given. */
function spawnEvent(event: VaultEvent, id: string | undefined): SpawnEvent {
  if (isGitEvent(event)) return event;
  if (id === undefined) throw new Error(`a ${event.kind} event needs an ID to spawn from`);
  return { ...event, id };
}

/** The spawn requests `event` makes in `targets`: every spawn condition it matches on their accepted mains, narrowed by scripts. */
export async function matchSpawns(
  m: SpawnMatching, given: { readonly event: VaultEvent; readonly id?: string }, targets: readonly RegisteredVault[],
  tree: { readonly parent?: string } = {},
): Promise<Result<MatchedSpawns, GitError>> {
  const candidates: Candidate[] = [];
  const runnable = new Map<string, { budget: Budget; actor: string }>();
  const paused: string[] = [];
  for (const vault of targets) {
    const accepted = await requireNoUnacceptedChange(m.git, m.store, vault);
    if (!accepted.ok) {
      paused.push(vault.id);
      continue;
    }
    const jobs = await vaultJobs(m.git, vault.path, accepted.value);
    if (!jobs.ok) return jobs;
    for (const job of jobs.value) {
      if (job.budget === undefined || job.actor === undefined) continue; // cannot spawn; `vault jobs` says why
      candidates.push({ vault: vault.id, document: job.path, conditions: job.conditions });
      runnable.set(`${vault.id}:${job.path}`, { budget: job.budget, actor: job.actor });
    }
  }
  const spawning = matchConditions(given.event, candidates, m.match).filter((match) => match.condition.effect === 'spawn');
  const narrowed = await narrowByScripts(
    { git: m.git, store: m.store, locate: (id) => m.vaults.find((v) => v.id === id) }, m.scripts, given.event, spawning,
  );
  const event = spawnEvent(given.event, given.id);
  return ok({
    requests: narrowed.kept.map((match) => ({
      vault: match.vault, document: match.document, condition: match.index, event,
      ...(runnable.get(`${match.vault}:${match.document}`) as { budget: Budget; actor: string }),
      ...(tree.parent === undefined ? {} : { parent: tree.parent }),
    })),
    dropped: narrowed.dropped.map((d) => ({ vault: d.match.vault, document: d.match.document, reason: d.reason })),
    paused,
  });
}

/**
 * Sends each request to the daemon when there is one, and queues it
 * otherwise — or when sending failed, even after the daemon may have claimed
 * it: the identity is the same, so queueing then finds that claim.
 */
export async function submitSpawns(store: Store, context: QueueContext, requests: readonly SpawnRequest[], send?: SpawnSender): Promise<SpawnEntry[]> {
  const entries: SpawnEntry[] = [];
  for (const request of requests) {
    let sent: SpawnEntry | undefined;
    if (send !== undefined) {
      try {
        sent = await send(request);
      } catch {
        sent = undefined; // a lost reply: queue it, which finds the daemon's claim if it made one
      }
    }
    entries.push(sent ?? enqueueSpawn(store, context, request).entry);
  }
  return entries;
}
