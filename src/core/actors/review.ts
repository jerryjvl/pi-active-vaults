// Reviewing a proposal (architecture.md "Review and accept"): what it changes,
// whether its checks passed, which changes are control changes, what the merge
// policy still needs — and a record of the exact commit reviewed. Records are
// kept per reviewer: an accept merges the commit its own approver last
// reviewed, so a review by anyone else can never stand in for an owner's.
// Review only reads, so it continues while `main` has an unaccepted change,
// against the recorded accepted `main`.

import type { Clock } from '../clock/index.ts';
import type { Git } from '../git/index.ts';
import { acceptedMain } from '../integrity/index.ts';
import { evaluateMerge, type MergeEvaluation, type PolicyError } from '../policy/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Queryable, Store } from '../store/index.ts';
import { readProposal, type Proposal, type ProposalError } from './proposal.ts';

export const actorsSchema: ModuleSchema = {
  module: 'actors',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE actors_reviews (
        vault TEXT NOT NULL,
        actor TEXT NOT NULL,
        sha TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (vault, actor)
      ) STRICT`,
    },
    {
      // One latest review per reviewer, not per actor (accept binds to the approver's own).
      version: 2,
      sql: `CREATE TABLE actors_reviews_by_reviewer (
        vault TEXT NOT NULL,
        actor TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        sha TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (vault, actor, reviewer)
      ) STRICT;
      INSERT INTO actors_reviews_by_reviewer (vault, actor, reviewer, sha, at) SELECT vault, actor, reviewer, sha, at FROM actors_reviews;
      DROP TABLE actors_reviews;
      ALTER TABLE actors_reviews_by_reviewer RENAME TO actors_reviews`,
    },
  ],
};

/** A reviewer's latest review of an actor's proposal: the exact commit they looked at. */
export interface ReviewRecord {
  readonly vault: string;
  readonly actor: string;
  readonly sha: string;
  readonly reviewer: string;
  readonly at: string;
}

export function reviewRecord(store: Queryable, vault: string, actor: string, reviewer: string): ReviewRecord | undefined {
  return store.get<ReviewRecord>(
    'SELECT vault, actor, sha, reviewer, at FROM actors_reviews WHERE vault = ? AND actor = ? AND reviewer = ?',
    [vault, actor, reviewer],
  );
}

export interface Review {
  readonly proposal: Proposal;
  readonly evaluation: MergeEvaluation;
  readonly record: ReviewRecord;
}

export type ReviewError = ProposalError | PolicyError | { readonly reason: 'no-accepted-main'; readonly vault: string };

export async function review(
  context: { readonly git: Git; readonly store: Store; readonly clock: Clock },
  vault: RegisteredVault,
  actor: string,
  reviewer: string,
): Promise<Result<Review, ReviewError>> {
  const { git, store, clock } = context;
  const accepted = acceptedMain(store, vault.id);
  if (accepted === undefined) return err({ reason: 'no-accepted-main', vault: vault.id });
  const proposal = await readProposal(git, vault.path, accepted, actor);
  if (!proposal.ok) return proposal;
  const { base, head, tainted } = proposal.value;
  const evaluation = await evaluateMerge(git, vault.path, { accepted, base, head, tainted });
  if (!evaluation.ok) return evaluation;
  const record: ReviewRecord = { vault: vault.id, actor, sha: head, reviewer, at: clock.now().toISOString() };
  store.run(
    `INSERT INTO actors_reviews (vault, actor, sha, reviewer, at) VALUES ($vault, $actor, $sha, $reviewer, $at)
     ON CONFLICT (vault, actor, reviewer) DO UPDATE SET sha = excluded.sha, at = excluded.at`,
    { ...record },
  );
  return ok({ proposal: proposal.value, evaluation: evaluation.value, record });
}
