// What the operations share: reading their parameters (already checked
// against their specs by the runner), the accepted `main` a reading operation
// works from, the actor a writing one writes as, and the dependency bundles
// the lower modules take.

import type { ForgeDeps } from '../../forge/index.ts';
import { acceptedMain, type AcceptedMain } from '../../integrity/index.ts';
import type { NotifyDeps } from '../../notify/index.ts';
import type { RegisteredVault } from '../../registry/index.ts';
import { err, ok, type Result } from '../../result/index.ts';
import type { SearchContext } from '../../search/index.ts';
import { packageIdentity, type OperationContext } from '../context.ts';
import type { Caller, OperationRequest } from '../types.ts';

export type Params = OperationRequest['params'];

export const text = (params: Params, name: string): string | undefined => (typeof params[name] === 'string' ? params[name] : undefined);
export const texts = (params: Params, name: string): string[] => (Array.isArray(params[name]) ? (params[name] as string[]) : []);
export const integer = (params: Params, name: string): number | undefined => (typeof params[name] === 'number' ? params[name] : undefined);
export const flag = (params: Params, name: string): boolean => params[name] === true;

/** The one vault of an operation scoped to one. */
export function theVault(request: OperationRequest): RegisteredVault {
  const [vault] = request.vaults;
  if (vault === undefined || request.vaults.length !== 1) throw new Error('an operation on one vault was given another number of them');
  return vault;
}

/** The recorded accepted main, which reading continues from during an unaccepted change. */
export function readingFrom(context: OperationContext, vault: RegisteredVault): Result<AcceptedMain, { reason: 'no-accepted-main'; vault: string }> {
  const accepted = acceptedMain(context.state, vault.id);
  return accepted === undefined ? err({ reason: 'no-accepted-main', vault: vault.id }) : ok(accepted);
}

/** The person whose owner act this is. */
export function personOf(caller: Caller): Result<string, { reason: 'no-person' }> {
  return caller.person === undefined ? err({ reason: 'no-person' }) : ok(caller.person);
}

/** The actor a write is made as: the caller's, or the one the parameters name where the surface allows it. */
export function actorOf(caller: Caller, params: Params): Result<string, { reason: 'no-person' }> {
  const actor = text(params, 'actor') ?? caller.actor ?? caller.person;
  return actor === undefined ? err({ reason: 'no-person' }) : ok(actor);
}

export function searchContext(context: OperationContext, index: SearchContext['index']): SearchContext {
  return {
    git: context.git,
    state: context.state,
    index,
    clock: context.clock,
    models: { client: { ...context.http, secrets: context.secrets }, config: context.installation.config },
  };
}

export function forgeDeps(context: OperationContext, person: string): ForgeDeps {
  return {
    client: context.http,
    secrets: context.secrets,
    git: context.git,
    store: context.state,
    clock: context.clock,
    attribution: { identity: packageIdentity(context.installation, person) },
    forges: context.installation.config.forges,
  };
}

/** Notification dependencies, when notify is configured. */
export function notifyDeps(context: OperationContext, env: Readonly<Record<string, string>>): NotifyDeps | undefined {
  const config = context.installation.notify;
  if (config === undefined) return undefined;
  return {
    store: context.state, config, clock: context.clock, secrets: context.secrets, env,
    ...(context.smtp === undefined ? {} : { smtp: context.smtp }),
  };
}

/** Lines of `text` from `start` to `end` (1-based, inclusive). */
export function lineRange(content: string, range: string | undefined): string {
  if (range === undefined) return content;
  const found = /^(\d+)(?:-(\d+))?$/.exec(range);
  if (found === null) return content;
  const start = Math.max(1, Number(found[1]));
  const end = found[2] === undefined ? start : Number(found[2]);
  return content.split('\n').slice(start - 1, end).join('\n');
}
