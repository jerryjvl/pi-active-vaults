// Git events from cursors (daemon.md "Matching", "Catch-up"; architecture.md
// "Change-triggered work"): for each vault, the merges on its accepted main
// (`merged`) and the commits on each actor branch (`committed`) since each
// job's cursor are matched against that job's conditions, the spawns they
// request claimed, and the cursor moved past them — event by event, so a
// crash between a claim and its cursor only repeats a claim that already
// exists. Events come from Git history, so nothing is lost while no daemon
// runs.
//
// Where a cursor starts: a job's cursor starts at the merge that introduced
// it to its vault's accepted main when this daemon already scans that vault,
// so a job accepted while the daemon was down still sees what followed it;
// in a vault the daemon takes up (newly registered or hosted) everything
// starts where its history is now, so taking a vault up replays nothing. A
// cursor whose commit has gone (rewritten history) restarts at the tip.
//
// Only accepted mains are read for jobs; `merged` events are derived only up
// to the accepted main, and a vault with an unaccepted change is neither a
// source of events nor a target of them while it is paused — its cursors
// stay where they were, so its events are matched once it is resolved.

import { deriveEvents } from '../events/index.ts';
import { isAncestor, lastAdded, listRefs, mergeBase, type GitError, type Sha } from '../git/index.ts';
import { acceptedMain, requireNoUnacceptedChange } from '../integrity/index.ts';
import { queueContext, type OperationContext } from '../operations/index.ts';
import {
  advanceCursor, gitStream, matchSpawns, reachedVaults, readCursor, submitSpawns, vaultJobs, type CursorKey, type Job, type SpawnMatching,
} from '../queue/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { ok, type Result } from '../result/index.ts';

/** The document a vault's own scan position is kept under: the vault as a whole, never a document's path. */
const WHOLE_VAULT = '';

interface Stream {
  readonly kind: 'merged' | 'committed';
  /** The cursor stream: `merged:<source>` or `committed:<source>:<branch>`. */
  readonly name: string;
  readonly tip: Sha;
}

interface Target {
  readonly vault: RegisteredVault;
  readonly job: Job;
  readonly key: CursorKey;
}

/** The streams of events `source` offers now: its accepted main's merges, each actor branch's commits. */
async function streamsOf(context: OperationContext, source: RegisteredVault, tip: Sha): Promise<Stream[]> {
  const streams: Stream[] = [{ kind: 'merged', name: gitStream('merged', source.id), tip }];
  const branches = await listRefs(context.git, source.path, 'refs/heads/actor/');
  for (const { ref, sha } of branches.ok ? branches.value : []) {
    streams.push({ kind: 'committed', name: gitStream('committed', `${source.id}:${ref.slice('refs/heads/'.length)}`), tip: sha });
  }
  return streams;
}

function listensTo(job: Job, kind: Stream['kind']): boolean {
  return job.budget !== undefined && job.actor !== undefined && job.conditions.some((c) => c.on === kind && c.effect === 'spawn');
}

/** Where a job seen for the first time starts on a stream. */
async function startOf(context: OperationContext, source: RegisteredVault, stream: Stream, target: Target, main: Sha): Promise<Sha> {
  const scanned = readCursor(context.state, { vault: target.vault.id, document: WHOLE_VAULT, stream: stream.name });
  if (scanned === undefined && stream.kind === 'committed') {
    // A branch made since the vault was taken up: from where it left the accepted main, so its first commits count.
    const takenUp = readCursor(context.state, { vault: target.vault.id, document: WHOLE_VAULT, stream: gitStream('merged', source.id) });
    const base = takenUp === undefined ? undefined : await mergeBase(context.git, source.path, stream.tip, main);
    return base?.ok === true && base.value !== undefined ? base.value : stream.tip;
  }
  if (scanned === undefined) return stream.tip; // a vault taken up now: from where its history is
  if (stream.kind !== 'merged' || source.id !== target.vault.id) return scanned;
  const introduced = await lastAdded(context.git, source.path, stream.tip, target.job.path);
  if (!introduced.ok || introduced.value === undefined || introduced.value === scanned) return scanned;
  const later = await isAncestor(context.git, source.path, scanned, introduced.value);
  return later.ok && later.value ? introduced.value : scanned;
}

/** Matches the events of one stream since one position against the jobs at that position, moving their cursors. */
async function catchUp(
  context: OperationContext, matching: SpawnMatching, source: RegisteredVault, stream: Stream, from: Sha, targets: readonly Target[],
): Promise<Result<void, GitError>> {
  const events = await deriveEvents(context.git, source.path, source.id, { kind: stream.kind, from, to: stream.tip });
  if (!events.ok) return events;
  const vaults = [...new Map(targets.map((t) => [t.vault.id, t.vault])).values()];
  const mine = new Set(targets.map((t) => `${t.vault.id}\0${t.job.path}`));
  let position = from;
  for (const event of events.value) {
    const matched = await matchSpawns(matching, { event }, vaults, {}, (vault, document) => mine.has(`${vault}\0${document}`));
    if (!matched.ok) return matched;
    await submitSpawns(context.state, queueContext(context), matched.value.requests);
    for (const target of targets) advanceCursor(context.state, context.clock, target.key, position, event.commit);
    position = event.commit;
  }
  return ok(undefined);
}

/** Matches every hosted, unpaused vault's jobs against the Git events since their cursors; `only` limits it to one source vault. */
export async function scanGitEvents(
  context: OperationContext, matching: SpawnMatching, hosted: readonly RegisteredVault[], paused: ReadonlySet<string>, only?: string,
): Promise<string[]> {
  const problems: string[] = [];
  const { vaults, config } = context.installation;
  for (const source of vaults) {
    if (only !== undefined && source.id !== only) continue;
    if (paused.has(source.id)) continue;
    const accepted = await requireNoUnacceptedChange(context.git, context.state, source);
    if (!accepted.ok) continue;
    const reached = reachedVaults(vaults, config.subscriptions, source.id).filter((v) => !paused.has(v.id) && hosted.some((h) => h.id === v.id));
    if (reached.length === 0) continue;
    const jobsOf = new Map<string, readonly Job[]>();
    for (const vault of reached) {
      const main = acceptedMain(context.state, vault.id);
      const jobs = main === undefined ? undefined : await vaultJobs(context.git, vault.path, main, context.reads);
      jobsOf.set(vault.id, jobs?.ok === true ? jobs.value : []);
    }
    for (const stream of await streamsOf(context, source, accepted.value.sha)) {
      const byPosition = new Map<Sha, Target[]>();
      for (const vault of reached) {
        for (const job of (jobsOf.get(vault.id) ?? []).filter((j) => listensTo(j, stream.kind))) {
          const key: CursorKey = { vault: vault.id, document: job.path, stream: stream.name };
          let position = readCursor(context.state, key);
          if (position === undefined) {
            position = await startOf(context, source, stream, { vault, job, key }, accepted.value.sha);
            advanceCursor(context.state, context.clock, key, null, position);
          }
          byPosition.set(position, [...(byPosition.get(position) ?? []), { vault, job, key }]);
        }
      }
      for (const [position, targets] of byPosition) {
        if (position === stream.tip) continue;
        const caught = await catchUp(context, matching, source, stream, position, targets);
        if (!caught.ok) {
          // The cursor's commit is gone (history rewritten): its targets restart at the tip, and say so.
          problems.push(`${source.id}: events from ${position} on ${stream.name} could not be read (${caught.error.reason}); its jobs start again at ${stream.tip}.`);
          for (const target of targets) advanceCursor(context.state, context.clock, target.key, position, stream.tip);
        }
      }
      for (const vault of reached) {
        const scanned: CursorKey = { vault: vault.id, document: WHOLE_VAULT, stream: stream.name };
        advanceCursor(context.state, context.clock, scanned, readCursor(context.state, scanned) ?? null, stream.tip);
      }
    }
  }
  return problems;
}
