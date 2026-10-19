// From an event to spawns (concepts.md "applies-when", extension.md
// "Spawns", daemon.md "Spawn lifecycle"): matching an event against the jobs of the
// vaults it reaches, then sending each request to the daemon or queueing it.
// `vault trigger`, Pi sessions and their commits use this, and so does the
// daemon.
//
// Invariants:
//  - jobs, their conditions and their scripts come from each vault's accepted
//    `main`; a vault with an unaccepted change is paused — reported, never
//    matched — because a spawn is a propagating action (security.md);
//  - a request's identity — document and event, with the event's ID fixed by
//    the caller before anything is sent — is decided before it is sent or
//    queued, so a request the daemon claimed and that was also queued after a
//    lost reply is one spawn: the claim is a unique insert;
//  - only spawn conditions spawn, only jobs with a budget, an actor and a
//    readable model request, and a condition's script only narrows; a request
//    writes as the job's actor and carries the model name it asks for — which
//    model answers it is decided at the claim (`enqueueSpawn`).

import { hasSession } from '../budgets/index.ts';
import { isGitEvent, matchConditions, narrowByScripts, type Candidate, type ChangedDocument, type GitEvent, type MatchContext, type ScriptFilterContext, type ScriptFilterOptions, type VaultEvent } from '../conditions/index.ts';
import type { Git, GitError } from '../git/index.ts';
import { requireNoUnacceptedChange, type AcceptedReads } from '../integrity/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { vaultJobs, type SpawnTerms } from './jobs.ts';
import { enqueueSpawn, type QueueContext, type SpawnEntry, type SpawnEvent, type SpawnRequest } from './spawns.ts';

export interface SpawnMatching {
  readonly git: Git;
  readonly store: Store;
  /** Every registered vault, so a filter script can be found in its own. */
  readonly vaults: readonly RegisteredVault[];
  readonly match: MatchContext;
  readonly scripts: ScriptFilterOptions;
  /** What has been read from accepted mains, kept while they stay accepted. */
  readonly reads?: AcceptedReads;
}

export interface MatchedSpawns {
  readonly requests: readonly SpawnRequest[];
  /** Matches a condition's script turned down, with why. */
  readonly dropped: readonly { readonly vault: string; readonly document: string; readonly reason: string }[];
  /** Vaults not matched because their `main` has an unaccepted change (or cannot be read). */
  readonly paused: readonly string[];
}

/** Where a matching's condition scripts run: each in its own registered vault. */
export function scriptFilters(m: SpawnMatching): ScriptFilterContext {
  return { git: m.git, store: m.store, locate: (id) => m.vaults.find((v) => v.id === id) };
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

/**
 * The spawn requests `event` makes in `targets`: every spawn condition it
 * matches on their accepted mains, narrowed by scripts — of only the jobs
 * `only` keeps, when given (the daemon matches each job from its own cursor).
 */
export async function matchSpawns(
  m: SpawnMatching, given: { readonly event: VaultEvent; readonly id?: string }, targets: readonly RegisteredVault[],
  tree: { readonly parent?: string } = {}, only?: (vault: string, document: string) => boolean,
): Promise<Result<MatchedSpawns, GitError>> {
  const candidates: Candidate[] = [];
  const runnable = new Map<string, SpawnTerms>();
  const paused: string[] = [];
  for (const vault of targets) {
    const accepted = await requireNoUnacceptedChange(m.git, m.store, vault);
    if (!accepted.ok) {
      paused.push(vault.id);
      continue;
    }
    const jobs = await vaultJobs(m.git, vault.path, accepted.value, m.reads);
    if (!jobs.ok) return jobs;
    for (const job of jobs.value) {
      if (job.terms === undefined) continue; // cannot spawn; `vault jobs` says why
      if (only !== undefined && !only(vault.id, job.path)) continue;
      candidates.push({ vault: vault.id, document: job.path, conditions: job.conditions });
      runnable.set(`${vault.id}:${job.path}`, job.terms);
    }
  }
  const requests: SpawnRequest[] = [];
  const dropped: MatchedSpawns['dropped'][number][] = [];
  for (const part of eventParts(m.store, given.event, tree)) {
    const spawning = matchConditions(part.event, candidates, m.match).filter((match) => match.condition.effect === 'spawn');
    const narrowed = await narrowByScripts(
      scriptFilters(m), m.scripts, part.event, spawning,
    );
    const event = spawnEvent(part.event, given.id);
    requests.push(...narrowed.kept.map((match) => ({
      vault: match.vault, document: match.document, condition: match.index, event,
      ...(runnable.get(`${match.vault}:${match.document}`) as SpawnTerms),
      ...(part.parent === undefined ? {} : { parent: part.parent }),
    })));
    dropped.push(...narrowed.dropped.map((d) => ({ vault: d.match.vault, document: d.match.document, reason: d.reason })));
  }
  return ok({ requests, dropped, paused });
}

/**
 * The parts of an event that spawn on their own, each in its session tree
 * (concepts.md "Session tree"): a Git event's changes grouped by the run that
 * made them (their `Vault-Trace`) — the part no run made first, then by
 * trace — each continuing its run's tree when that run is known here, and
 * otherwise starting a new one; any other event is one part, in `tree`.
 */
function eventParts(store: Store, event: VaultEvent, tree: { readonly parent?: string }): { event: VaultEvent; parent?: string }[] {
  if (!isGitEvent(event)) return [{ event, ...(tree.parent === undefined ? {} : { parent: tree.parent }) }];
  // Keyed by trace, '' for the part no run made, which so sorts first.
  const byRun = new Map<string, ChangedDocument[]>();
  for (const change of event.changes) byRun.set(change.trace ?? '', [...(byRun.get(change.trace ?? '') ?? []), change]);
  if (byRun.size === 0) byRun.set('', []);
  return [...byRun.keys()].sort().map((run) => {
    const part: GitEvent = { ...event, changes: byRun.get(run) ?? [], ...(run === '' ? {} : { tree: run }) };
    const parent = run === '' ? tree.parent : hasSession(store, run) ? run : undefined;
    return { event: part, ...(parent === undefined ? {} : { parent }) };
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
