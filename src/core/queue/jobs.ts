// The jobs of a vault (concepts.md "Built from the core": a job is a document
// with a `spawn` condition, a budget and an actor), as its accepted `main`
// declares them — what `vault jobs` lists, `vault run` and `vault trigger`
// queue, and the daemon matches. A job whose budget or actor cannot be read
// is listed with why, and lacks it, so nothing can spawn it.
//
// A job writes as its `actor` — its own, else its nearest contract's — which
// must be one of the vault's `actors`: an agent role, never an owner, so
// unattended work always lands in a review lane an owner did not write.

import { parseBudget, type Budget } from '../budgets/index.ts';
import { documentConditions, type DocumentConditions } from '../conditions/index.ts';
import type { Git, GitError } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { isVaultActor, readVaultIdentity, type VaultIdentity } from '../registry/index.ts';
import { DataReader, ok, type Issue, type Result } from '../result/index.ts';

export interface Job {
  readonly path: string;
  readonly conditions: DocumentConditions['conditions'];
  /** Absent when it cannot be read: the job cannot spawn. */
  readonly budget?: Budget;
  /** Whom it writes as; absent when there is none that may: the job cannot spawn. */
  readonly actor?: string;
  readonly issues: readonly Issue[];
}

/** The job's actor, if it names one of the vault's `actors`; otherwise the issues saying why not. */
function jobActor(path: string, declared: DocumentConditions['actor'], identity: VaultIdentity | undefined): Result<string, Issue[]> {
  const r = new DataReader();
  if (declared === undefined) {
    r.add('actor', 'is required on a document that can spawn work, in its frontmatter or a contract');
    return r.result('');
  }
  // Issues are the document's; one about an inherited actor names the contract it comes from.
  const where = declared.origin === path ? 'actor' : `${declared.origin}:actor`;
  const actor = r.string(declared.value, where);
  if (actor !== '' && identity === undefined) r.add(where, 'cannot be checked: the vault\'s actors cannot be read');
  else if (actor !== '' && identity !== undefined && !isVaultActor(identity, actor)) r.add(where, 'is not one of the vault\'s actors');
  return r.result(actor);
}

/** The vault's jobs, and documents whose conditions cannot be read, by path. */
export async function vaultJobs(git: Git, repo: string, accepted: AcceptedMain): Promise<Result<Job[], GitError>> {
  const documents = await documentConditions(git, repo, accepted);
  if (!documents.ok) return documents;
  // Without the vault's identity no actor can be shown to be one of its own: every job then says so, and none spawns.
  const identity = await readVaultIdentity(git, repo, accepted.sha);
  const jobs: Job[] = [];
  for (const document of documents.value) {
    const spawns = document.conditions.some((c) => c.effect === 'spawn');
    if (!spawns && document.issues.length === 0) continue;
    const budget = spawns ? parseBudget(document.budget) : undefined;
    const actor = spawns ? jobActor(document.path, document.actor, identity.ok ? identity.value : undefined) : undefined;
    jobs.push({
      path: document.path,
      conditions: document.conditions,
      ...(budget?.ok === true ? { budget: budget.value } : {}),
      ...(actor?.ok === true ? { actor: actor.value } : {}),
      issues: [...document.issues, ...(budget?.ok === false ? budget.error : []), ...(actor?.ok === false ? actor.error : [])],
    });
  }
  return ok(jobs);
}
