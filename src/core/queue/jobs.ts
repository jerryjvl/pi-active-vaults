// The jobs of a vault (concepts.md "Built from the core": a job is a document
// with a `spawn` condition, a budget and an actor), as its accepted `main`
// declares them — what `vault jobs` lists, `vault run` and `vault trigger`
// queue, and the daemon matches. A job whose budget or actor cannot be read
// is listed with why, and lacks it, so nothing can spawn it.
//
// A job writes as its `actor` — its own, else its nearest contract's — which
// must be one of the vault's `actors`: an agent role, never an owner, so
// unattended work always lands in a review lane an owner did not write.
//
// A job may ask for the `agent` model it runs on, by name — its own `model`,
// else its nearest contract's. The name is only a request: which model answers
// it, and whether policy allows it, is the models module's to say at the
// claim. A `model` that is not a name is an issue and the job cannot spawn:
// a malformed request is not guessed at.

import { parseBudget, type Budget } from '../budgets/index.ts';
import { documentConditions, type DocumentConditions } from '../conditions/index.ts';
import { MODEL_NAME } from '../config/index.ts';
import type { Git, GitError } from '../git/index.ts';
import { UNCACHED_READS, acceptedIdentity, type AcceptedMain, type AcceptedReads } from '../integrity/index.ts';
import { isVaultActor, type VaultIdentity } from '../registry/index.ts';
import { DataReader, ok, type Issue, type Result } from '../result/index.ts';

/** What a spawn of a job is made of: its budget, whom it writes as and the model it asks for. */
export interface SpawnTerms {
  readonly budget: Budget;
  readonly actor: string;
  /** The `agent` model it asks for, by name; absent: the default. */
  readonly model?: string;
}

export interface Job {
  readonly path: string;
  readonly conditions: DocumentConditions['conditions'];
  /** Absent when it cannot be read: the job cannot spawn. */
  readonly budget?: Budget;
  /** Whom it writes as; absent when there is none that may: the job cannot spawn. */
  readonly actor?: string;
  /** The model it asks for, by name; absent: the default `agent`. */
  readonly model?: string;
  /** Present exactly when the job can spawn: budget, actor and model all readable. */
  readonly terms?: SpawnTerms;
  readonly issues: readonly Issue[];
}

/** Issues are the document's; one about an inherited key names the contract it comes from. */
function issueWhere(key: string, path: string, declared: { readonly origin: string }): string {
  return declared.origin === path ? key : `${declared.origin}:${key}`;
}

/** The job's actor, if it names one of the vault's `actors`; otherwise the issues saying why not. */
function jobActor(path: string, declared: DocumentConditions['actor'], identity: VaultIdentity | undefined): Result<string, Issue[]> {
  const r = new DataReader();
  if (declared === undefined) {
    r.add('actor', 'is required on a document that can spawn work, in its frontmatter or a contract');
    return r.result('');
  }
  const where = issueWhere('actor', path, declared);
  const actor = r.string(declared.value, where);
  if (actor !== '' && identity === undefined) r.add(where, 'cannot be checked: the vault\'s actors cannot be read');
  else if (actor !== '' && identity !== undefined && !isVaultActor(identity, actor)) r.add(where, 'is not one of the vault\'s actors');
  return r.result(actor);
}

/** The job's requested model name, if it asks for one; otherwise the issues saying why not. */
function jobModel(path: string, declared: DocumentConditions['model']): Result<string | undefined, Issue[]> {
  const r = new DataReader();
  if (declared === undefined) return r.result(undefined);
  return r.result(r.string(declared.value, issueWhere('model', path, declared), MODEL_NAME) || undefined);
}

/** The vault's jobs, and documents whose conditions cannot be read, by path; read once per accepted main with `reads`. */
export function vaultJobs(git: Git, repo: string, accepted: AcceptedMain, reads: AcceptedReads = UNCACHED_READS): Promise<Result<Job[], GitError>> {
  return reads.read(accepted, 'jobs', () => readJobs(git, repo, accepted, reads));
}

async function readJobs(git: Git, repo: string, accepted: AcceptedMain, reads: AcceptedReads): Promise<Result<Job[], GitError>> {
  const documents = await documentConditions(git, repo, accepted, reads);
  if (!documents.ok) return documents;
  // Without the vault's identity no actor can be shown to be one of its own: every job then says so, and none spawns.
  const identity = await acceptedIdentity(reads, git, repo, accepted);
  const jobs: Job[] = [];
  for (const document of documents.value) {
    const spawns = document.conditions.some((c) => c.effect === 'spawn');
    if (!spawns && document.issues.length === 0) continue;
    const budget = spawns ? parseBudget(document.budget) : undefined;
    const actor = spawns ? jobActor(document.path, document.actor, identity.ok ? identity.value : undefined) : undefined;
    const model = spawns ? jobModel(document.path, document.model) : undefined;
    const terms = budget?.ok === true && actor?.ok === true && model?.ok === true
      ? { budget: budget.value, actor: actor.value, ...(model.value === undefined ? {} : { model: model.value }) }
      : undefined;
    jobs.push({
      path: document.path,
      conditions: document.conditions,
      ...(budget?.ok === true ? { budget: budget.value } : {}),
      ...(actor?.ok === true ? { actor: actor.value } : {}),
      ...(model?.ok === true && model.value !== undefined ? { model: model.value } : {}),
      ...(terms === undefined ? {} : { terms }),
      issues: [...document.issues, ...(budget?.ok === false ? budget.error : []), ...(actor?.ok === false ? actor.error : []), ...(model?.ok === false ? model.error : [])],
    });
  }
  return ok(jobs);
}
