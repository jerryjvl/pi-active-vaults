// What the operations share: reading their parameters (already checked
// against their specs by the runner), the accepted `main` a reading operation
// works from, the actor a writing one writes as, and the dependency bundles
// the lower modules take, and where the installation person works.

import { actorWorktreePath } from '../../actors/index.ts';
import type { ForgeDeps } from '../../forge/index.ts';
import { MAIN_BRANCH, acceptedIdentity, acceptedMain, type AcceptedMain } from '../../integrity/index.ts';
import type { NotifyDeps } from '../../notify/index.ts';
import { isOwner, isVaultActor, readVaultIdentity, type IdentityError, type RegisteredVault, type VaultIdentity } from '../../registry/index.ts';
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

/**
 * The identity the vault declares at its accepted main (from the reads
 * cache), or at `main` itself when nothing was accepted yet — what a reading
 * operation says about a vault no owner has accepted.
 */
export function identityOf(context: OperationContext, vault: RegisteredVault): Promise<Result<VaultIdentity, IdentityError>> {
  const accepted = acceptedMain(context.state, vault.id);
  return accepted === undefined
    ? readVaultIdentity(context.git, vault.path, `refs/heads/${MAIN_BRANCH}`)
    : acceptedIdentity(context.reads, context.git, vault.path, accepted);
}

/** Where the installation's person works in the vault: their actor worktree, which lives under the state directory unless the vault configures another. */
export function ownWorktree(context: OperationContext, vault: RegisteredVault): string | undefined {
  const { person } = context.installation.config;
  return person === undefined ? undefined : actorWorktreePath(vault, person);
}

/** The person whose owner act this is. */
export function personOf(caller: Caller): Result<string, { reason: 'no-person' }> {
  return caller.person === undefined ? err({ reason: 'no-person' }) : ok(caller.person);
}

export type WriterError = { readonly reason: 'no-person' } | { readonly reason: 'not-a-vault-actor'; readonly vault: string; readonly actor: string } | IdentityError;

/**
 * The actor a write is made as: the one the parameters name where the
 * surface offers it, else the caller's, else the person's. Over MCP it is
 * always named and must be one of the vault's `actors`, never an owner
 * (mcp.md "Rules"): a client is no person, and what it read is unknown, so
 * it never writes as one — not even as its profile's owner.
 */
export async function writerOf(context: OperationContext, vault: RegisteredVault, caller: Caller, params: Params): Promise<Result<string, WriterError>> {
  const named = text(params, 'actor');
  if (caller.surface !== 'mcp') {
    const actor = named ?? caller.actor ?? caller.person;
    return actor === undefined ? err({ reason: 'no-person' }) : ok(actor);
  }
  if (named === undefined) return err({ reason: 'no-person' });
  const identity = await identityOf(context, vault);
  if (!identity.ok) return identity;
  return isVaultActor(identity.value, named) && !isOwner(identity.value, named) ? ok(named) : err({ reason: 'not-a-vault-actor', vault: vault.id, actor: named });
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
    reads: context.reads,
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

