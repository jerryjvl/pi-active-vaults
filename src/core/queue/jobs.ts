// The jobs of a vault (concepts.md "Built from the core": a job is a document
// with a `spawn` condition and a budget), as its accepted `main` declares
// them — what `vault jobs` lists, `vault run` and `vault trigger` queue, and
// the daemon matches. A job whose budget cannot be read is listed with why,
// and has no budget, so nothing can spawn it.

import { parseBudget, type Budget } from '../budgets/index.ts';
import { documentConditions, type DocumentConditions } from '../conditions/index.ts';
import type { Git, GitError } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { ok, type Issue, type Result } from '../result/index.ts';

export interface Job {
  readonly path: string;
  readonly conditions: DocumentConditions['conditions'];
  /** Absent when it cannot be read: the job cannot spawn. */
  readonly budget?: Budget;
  readonly issues: readonly Issue[];
}

/** The vault's jobs, and documents whose conditions cannot be read, by path. */
export async function vaultJobs(git: Git, repo: string, accepted: AcceptedMain): Promise<Result<Job[], GitError>> {
  const documents = await documentConditions(git, repo, accepted);
  if (!documents.ok) return documents;
  const jobs: Job[] = [];
  for (const document of documents.value) {
    const spawns = document.conditions.some((c) => c.effect === 'spawn');
    if (!spawns && document.issues.length === 0) continue;
    const budget = spawns ? parseBudget(document.budget) : undefined;
    jobs.push({
      path: document.path,
      conditions: document.conditions,
      ...(budget?.ok === true ? { budget: budget.value } : {}),
      issues: [...document.issues, ...(budget?.ok === false ? budget.error : [])],
    });
  }
  return ok(jobs);
}
