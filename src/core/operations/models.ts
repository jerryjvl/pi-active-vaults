// What the installation's models come to for the documents of its vaults:
// whether a job has an `agent` model it may use, and what `vault doctor`
// says about the models jobs and judgement axes ask for (concepts.md
// "Models"). The decisions are the models module's (`resolveModel`); this
// only reads what documents ask for, from the accepted `main`, and words the
// outcome once for every surface that shows it.

import type { InstallationConfig, ModelRole } from '../config/index.ts';
import { axisModelRequests } from '../judgements/index.ts';
import type { Git } from '../git/index.ts';
import type { AcceptedMain, AcceptedReads } from '../integrity/index.ts';
import { resolveModel, type ModelUnavailable, type PermittedModel } from '../models/index.ts';
import { vaultJobs, type Job } from '../queue/index.ts';
import type { Result } from '../result/index.ts';

type ModelsConfig = Pick<InstallationConfig, 'models' | 'policy'>;

const an = (role: ModelRole): string => (role === 'agent' ? 'an agent' : `a ${role}`);

/** Whether a job spawns at all: it has a spawn condition. */
export const hasSpawnCondition = (job: Job): boolean => job.conditions.some((c) => c.effect === 'spawn');

/** The `agent` model that would answer a job's request in `vault`, or why none can. */
export function jobModel(config: ModelsConfig, vault: string, job: Job): Result<PermittedModel<'agent'>, ModelUnavailable> {
  return resolveModel(config, 'agent', [vault], job.model);
}

/** Why no model can answer, in a few words (after "no agent model it may use"). */
export function unavailableText(why: ModelUnavailable): string {
  switch (why.reason) {
    case 'no-default':
      return why.requested === undefined ? `the default ${why.role} model is not configured` : `"${why.requested}" is not configured, and neither is the default ${why.role} model`;
    case 'wrong-role':
      return `"${why.name}" is ${an(why.actual)} model`;
    case 'not-allowed':
      return `the policy does not allow "${why.name}" for ${why.vault}`;
  }
}

/** The jobs of `vault` that cannot run for lack of an `agent` model, with why. */
export function jobsWithoutModel(config: ModelsConfig, vault: string, jobs: readonly Job[]): { readonly job: Job; readonly why: ModelUnavailable }[] {
  return jobs.filter(hasSpawnCondition).flatMap((job) => {
    const model = jobModel(config, vault, job);
    return model.ok ? [] : [{ job, why: model.error }];
  });
}

interface Asked {
  readonly subject: string;
  readonly role: ModelRole;
  readonly requested?: string;
  /** What happens to the thing without its model. */
  readonly without: { readonly one: string; readonly many: string };
}

const JOB_WITHOUT = { one: 'it cannot run', many: 'they cannot run' };
const AXIS_WITHOUT = { one: 'it stays unjudged', many: 'they stay unjudged' };

/**
 * What `vault doctor` says about the models the accepted main's jobs and axes
 * ask for in `vault`: names that are not configured (and the default that
 * answers instead), names with the wrong role, models the policy does not
 * allow, and defaults that are needed but missing — one message per default.
 */
export async function modelMessages(
  config: ModelsConfig, git: Git, repo: string, vault: string, accepted: AcceptedMain, reads: AcceptedReads,
): Promise<string[]> {
  const jobs = await vaultJobs(git, repo, accepted, reads);
  const axes = await axisModelRequests(git, repo, accepted, reads);
  const asked: Asked[] = [
    ...(jobs.ok ? jobs.value.filter(hasSpawnCondition).map((job): Asked => ({ subject: job.path, role: 'agent', ...(job.model === undefined ? {} : { requested: job.model }), without: JOB_WITHOUT })) : []),
    ...(axes.ok ? axes.value.map((a): Asked => ({ subject: `axis ${a.axis} (${a.contract})`, role: 'judgement', ...(a.model === undefined ? {} : { requested: a.model }), without: AXIS_WITHOUT })) : []),
  ];
  const messages: string[] = [];
  const missing = new Map<ModelRole, Asked[]>();
  for (const ask of asked) {
    const model = resolveModel(config, ask.role, [vault], ask.requested);
    if (model.ok) {
      if (model.value.substitutedFor !== undefined) {
        messages.push(`${ask.subject} asks for the ${ask.role} model "${model.value.substitutedFor}", which is not configured; the default "${ask.role}" answers instead.`);
      }
      continue;
    }
    const why = model.error;
    if (why.reason === 'no-default') missing.set(ask.role, [...(missing.get(ask.role) ?? []), ask]);
    else if (why.reason === 'wrong-role') messages.push(`${ask.subject} asks for "${why.name}", which is ${an(why.actual)} model, not ${an(ask.role)} model; ${ask.without.one}.`);
    else if (why.name === ask.role) messages.push(`${ask.subject}: the policy does not allow the default ${ask.role} model for this vault; ${ask.without.one}.`);
    else messages.push(`${ask.subject}: the policy does not allow the ${ask.role} model "${why.name}" for this vault, and the default does not take its place; ${ask.without.one}.`);
  }
  for (const [role, needing] of missing) {
    const many = needing.length > 1;
    messages.push(`the default ${role} model is not configured, which ${needing.map((n) => n.subject).join(', ')} ${many ? 'need' : 'needs'}; ${needing[0] === undefined ? '' : many ? needing[0].without.many : needing[0].without.one}.`);
  }
  return messages;
}
