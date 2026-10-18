// Merge results (security-setup.md): whether a proposal merged in the forge
// reached `main` with its commits. Attestations and trace notes are attached
// to the reviewed commits, so a squash or rebase merge — which replaces them —
// leaves them attached to nothing in `main`. Forge settings should forbid
// those methods; this is the check that holds whatever the settings were.
//
// Invariants:
//  - what merged is asked before `main` is fetched, so every merge the forge
//    names is in the `main` it is judged against: one made in between is
//    named on the next round instead of being misjudged;
//  - a merge is judged once: its result is recorded per vault and pull
//    request, and only newly recorded results are returned (so owners are
//    told once);
//  - a head that is missing here is not in `main`: fetching `main` brings
//    every commit it contains.

import { actorBranch } from '../actors/index.ts';
import { isAncestor, type Sha } from '../git/index.ts';
import { MAIN_BRANCH, type AcceptedMain, type VaultLocation } from '../integrity/index.ts';
import { ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Queryable, Store } from '../store/index.ts';
import type { PullRequest } from './adapter.ts';
import { connectForge, type ForgeDeps, type ForgeSyncError } from './sync.ts';

export const forgeSchema: ModuleSchema = {
  module: 'forge',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE forge_merges (
        vault TEXT NOT NULL,
        pull INTEGER NOT NULL,
        url TEXT NOT NULL,
        actor TEXT NOT NULL,
        head TEXT NOT NULL,
        main TEXT NOT NULL,
        kept INTEGER NOT NULL CHECK (kept IN (0, 1)),
        at TEXT NOT NULL,
        PRIMARY KEY (vault, pull)
      ) STRICT`,
    },
  ],
};

/** A proposal the forge says was merged: its pull request, the actor whose branch it was, and the head it was merged at. */
export interface MergedProposal {
  readonly pull: PullRequest;
  readonly actor: string;
}

export interface MergeResult {
  readonly vault: string;
  readonly pull: number;
  readonly url: string;
  readonly actor: string;
  readonly head: Sha;
  /** The accepted main it was judged against. */
  readonly main: Sha;
  /** Whether the head is in that main: its commits, and what is attached to them, reached it. */
  readonly kept: boolean;
  readonly at: string;
}

/** The writers' proposals merged most recently in the forge and not judged yet. Asked before fetching `main`. */
export async function uncheckedMerges(deps: ForgeDeps, vault: VaultLocation, writers: readonly string[]): Promise<Result<MergedProposal[], ForgeSyncError>> {
  const adapter = await connectForge(deps, vault);
  if (!adapter.ok) return adapter;
  const merged = await adapter.value.mergedPullRequests(MAIN_BRANCH);
  if (!merged.ok) return merged;
  const judged = new Set(deps.store.all<{ pull: number }>('SELECT pull FROM forge_merges WHERE vault = ?', [vault.id]).map((r) => r.pull));
  const unchecked: MergedProposal[] = [];
  for (const pull of merged.value) {
    const actor = writers.find((w) => actorBranch(w) === pull.head);
    if (actor !== undefined && !judged.has(pull.number)) unchecked.push({ pull, actor });
  }
  return ok(unchecked);
}

/** Judges each merge against `accepted` — fetched after the merges were asked — and records it; returns the results recorded now. */
export async function checkMerges(deps: ForgeDeps, vault: VaultLocation, accepted: AcceptedMain, merges: readonly MergedProposal[]): Promise<Result<MergeResult[], ForgeSyncError>> {
  const recorded: MergeResult[] = [];
  for (const { pull, actor } of merges) {
    const contained = await isAncestor(deps.git, vault.path, pull.headSha, accepted.sha);
    if (!contained.ok && contained.error.reason !== 'unknown-revision') return contained;
    const result: MergeResult = {
      vault: vault.id, pull: pull.number, url: pull.url, actor, head: pull.headSha, main: accepted.sha, kept: contained.ok && contained.value, at: deps.clock.now().toISOString(),
    };
    if (recordMerge(deps.store, result)) recorded.push(result);
  }
  return ok(recorded);
}

/** Records a merge's result unless it is recorded already; whether it was recorded now. */
function recordMerge(store: Store, r: MergeResult): boolean {
  return store.run(
    'INSERT INTO forge_merges (vault, pull, url, actor, head, main, kept, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    [r.vault, r.pull, r.url, r.actor, r.head, r.main, r.kept ? 1 : 0, r.at],
  ).changes === 1;
}

/** The vault's merged proposals whose commits did not reach `main`, newest pull request first. */
export function lostMerges(store: Queryable, vault: string): MergeResult[] {
  return store.all<Omit<MergeResult, 'kept'> & { kept: number }>(
    'SELECT vault, pull, url, actor, head, main, kept, at FROM forge_merges WHERE vault = ? AND kept = 0 ORDER BY pull DESC', [vault],
  ).map((r) => ({ ...r, kept: false }));
}

/** What a lost merge means, in one line: for status, doctor and the owners. */
export function lostMergeText(r: MergeResult): string {
  return `Pull request #${r.pull} from ${r.actor} (${actorBranch(r.actor)}${r.url === '' ? '' : `, ${r.url}`}) was merged without its commits: its head ${r.head} is not in main (${r.main}), so its attestations and trace notes no longer attach.`;
}
