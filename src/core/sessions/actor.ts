// Where a session writes, and as whom (extension.md "Actor and budget",
// concepts.md "Actor"): its actor's worktree in each vault that actor may
// write in, the hold it takes there, and — for an interactive session — the
// person changing that actor.
//
// Invariants:
//  - a session writes as one actor at a time, and in a vault only as one of
//    its `actors` or `owners` (from the accepted main), in that actor's
//    worktree; a headless run writes only in its own vault, as one of its
//    `actors`;
//  - a hold is taken per vault, when the session first writes there (or, in
//    the vault it runs in, at its start): holding every vault up front would
//    keep their actors from other writers for nothing;
//  - only the person changes an interactive session's actor — this is a
//    command, never a tool, so a model never chooses whose name or review lane
//    its work goes under; a name that writes in no vault changes nothing, and
//    work left uncommitted stays in the old actor's worktree, and is said.

import { existsSync } from 'node:fs';
import { actorWorktreePath, ensureActorWorktree, releaseActorHold, takeActorHold } from '../actors/index.ts';
import { stepsIn, uncommittedPaths } from '../git/index.ts';
import { acceptedIdentity, acceptedMain, type AcceptedMain } from '../integrity/index.ts';
import type { OperationContext, VaultScope } from '../operations/index.ts';
import { isActor, isVaultActor, type RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { SessionRefusal, VaultSession } from './session.ts';
import { logSession } from './trace.ts';

/** What tells the session that only the person can change its actor. */
const PERSON_CHANGES_ACTOR = 'Only the person can change the session\'s actor, with /vault actor <name>.';

/** Whether `actor` writes in `vault`, by its accepted main — for a headless run, only as one of its `actors` — and that accepted main. */
async function mayWrite(context: OperationContext, vault: RegisteredVault, actor: string, headless: boolean): Promise<Result<AcceptedMain, SessionRefusal>> {
  const accepted = acceptedMain(context.state, vault.id);
  if (accepted === undefined) return err({ reason: 'no-accepted-main', vault: vault.id });
  const identity = await acceptedIdentity(context.reads, context.git, vault.path, accepted);
  if (!identity.ok) return identity;
  if (!isActor(identity.value, actor)) return err({ reason: 'not-a-writer', vault: vault.id, actor });
  // Unattended work writes only in an agent's review lane, never as an owner (concepts.md "Document": a job's actor).
  if (headless && !isVaultActor(identity.value, actor)) return err({ reason: 'not-a-vault-actor', vault: vault.id, actor });
  return ok(accepted);
}

/** `actor`'s worktree in `vault`, made if missing, when it may write there. */
export async function prepareWriter(context: OperationContext, vault: RegisteredVault, actor: string, headless = false): Promise<Result<string, SessionRefusal>> {
  const accepted = await mayWrite(context, vault, actor, headless);
  if (!accepted.ok) return accepted;
  const worktree = await ensureActorWorktree(context.git, vault, accepted.value, actor, context.reads);
  return worktree.ok ? ok(worktree.value.path) : worktree;
}

export function refusalText(refusal: SessionRefusal, actor: string): string {
  switch (refusal.reason) {
    case 'no-actor':
      return 'This session writes as no actor: the installation has no person, and none was given with --vault-actor.';
    case 'not-its-vault':
      return `A job writes only in its own vault, not in vault "${refusal.vault}".`;
    case 'no-accepted-main':
      return `Nothing in vault "${refusal.vault}" is accepted yet, so this session writes nothing there.`;
    case 'not-a-writer':
      return `${refusal.actor} is not one of the actors or owners of vault "${refusal.vault}", so this session writes nothing there.`;
    case 'actor-busy':
      return `${actor} is held by session ${refusal.hold.holder.session} (process ${refusal.hold.holder.process.pid}); writes as ${actor} wait until it is free.`;
    case 'cannot-hold':
      return `This session cannot hold ${actor}: its own process cannot be told apart from another, so it writes nothing.`;
    default:
      return `This session cannot write as ${actor} (${refusal.reason}).`;
  }
}

/** A refusal to write, worded for the session: an interactive one is told who can change its actor; a run has no one to ask. */
export function writeRefusalText(session: VaultSession, refusal: SessionRefusal): string {
  const text = refusalText(refusal, session.actor ?? 'the actor');
  return session.mode === 'interactive' ? `${text} ${PERSON_CHANGES_ACTOR}` : text;
}

/** Whether the session's actor writes in `vault`; a headless run writes in no vault but its own. */
async function sessionMayWrite(context: OperationContext, session: VaultSession, vault: RegisteredVault): Promise<Result<{ actor: string; accepted: AcceptedMain }, SessionRefusal>> {
  const { actor } = session;
  if (actor === undefined) return err({ reason: 'no-actor' });
  if (session.mode === 'headless' && vault.id !== session.vault?.id) return err({ reason: 'not-its-vault', vault: vault.id });
  const accepted = await mayWrite(context, vault, actor, session.mode === 'headless');
  return accepted.ok ? ok({ actor, accepted: accepted.value }) : accepted;
}

/** The session's worktree in `vault`, made if missing — only where its actor may write. */
export async function writerIn(context: OperationContext, session: VaultSession, vault: RegisteredVault): Promise<Result<string, SessionRefusal>> {
  const known = session.worktrees.get(vault.id);
  if (known !== undefined) return ok(known);
  const allowed = await sessionMayWrite(context, session, vault);
  if (!allowed.ok) return allowed;
  const worktree = await ensureActorWorktree(context.git, vault, allowed.value.accepted, allowed.value.actor, context.reads);
  if (!worktree.ok) return worktree;
  session.worktrees.set(vault.id, worktree.value.path);
  return ok(worktree.value.path);
}

/** Takes the session's actor in `vault` if it does not hold it there yet — a busy one may be free now — and gives its worktree there. */
export async function holdIn(context: OperationContext, session: VaultSession, vault: RegisteredVault): Promise<Result<string, SessionRefusal>> {
  const worktree = await writerIn(context, session, vault);
  const { actor, holder } = session;
  if (!worktree.ok || session.holds.has(vault.id) || actor === undefined) return worktree;
  if (holder === undefined) return err({ reason: 'cannot-hold' });
  const taken = await takeActorHold(context.state, context.alive, context.clock, { vault: vault.id, actor, holder });
  if (!taken.ok) return taken;
  session.holds.add(vault.id);
  return worktree;
}

/** Releases every hold the session has. */
export function releaseHolds(context: OperationContext, session: VaultSession): void {
  const { actor, holder } = session;
  if (actor !== undefined && holder !== undefined) {
    for (const vault of session.holds) releaseActorHold(context.state, { vault, actor, holder });
  }
  session.holds.clear();
}

/**
 * Before an operation, the hold it may need: one on a single vault may write
 * there (a commit, a script), so the session takes its actor there first; one
 * over many vaults only reads. A hold that cannot be taken is no reason not
 * to run: an operation that writes says itself that the actor is busy.
 */
export async function holdForOperation(context: OperationContext, session: VaultSession, scope: VaultScope, vaults: readonly RegisteredVault[]): Promise<void> {
  if (scope !== 'one') return;
  for (const vault of vaults) await holdIn(context, session, vault);
}

/**
 * Where the session writes, for the person and the model alike: as whom, and
 * its worktree in each vault — or why not there. It makes no worktree:
 * one is made when the session first writes in its vault.
 */
export async function describeWriting(context: OperationContext, session: VaultSession): Promise<string> {
  const { actor } = session;
  if (actor === undefined) return `${refusalText({ reason: 'no-actor' }, '')} ${PERSON_CHANGES_ACTOR}`;
  const lines = [`This session writes as ${actor}: in each vault only in ${actor}'s worktree, committing with vault_commit.`];
  for (const vault of context.installation.vaults) {
    const made = session.worktrees.get(vault.id);
    const allowed = made === undefined ? await sessionMayWrite(context, session, vault) : ok(undefined);
    const path = made ?? actorWorktreePath(vault, actor);
    const state = session.holds.has(vault.id) ? ' (held by this session)' : existsSync(path) ? '' : ' (made when first written)';
    lines.push(`  ${vault.id}: ${allowed.ok ? `${path}${state}` : refusalText(allowed.error, actor)}`);
  }
  if (context.installation.vaults.length === 0) lines.push('  No vaults are registered.');
  lines.push(PERSON_CHANGES_ACTOR);
  return lines.join('\n');
}

export type SwitchRefusal = { readonly reason: 'headless' } | { readonly reason: 'writes-nowhere'; readonly actor: string };

export function switchRefusalText(refusal: SwitchRefusal): string {
  return refusal.reason === 'headless'
    ? 'A job runs as its own actor; it does not change.'
    : `${refusal.actor} writes in no registered vault (it is none's actor or owner, or none has an accepted main); the session writes as before.`;
}

/** What the old actor left uncommitted, vault by vault, with how to commit it there. */
async function leftUncommitted(context: OperationContext, session: VaultSession, actor: string): Promise<string[]> {
  const lines: string[] = [];
  for (const [vault, worktree] of session.worktrees) {
    const paths = await uncommittedPaths(context.git, worktree);
    if (!paths.ok) lines.push(`${vault}: whether ${actor}'s worktree has uncommitted changes cannot be told (${paths.error.reason}); look before you switch back: ${worktree}`);
    else if (paths.value.length > 0) {
      lines.push(
        `${vault}: ${paths.value.length} uncommitted change(s) stay in ${actor}'s worktree. Switch back to commit them, or commit them there:`,
        stepsIn(worktree, ['git status', `vault commit ${vault} --actor ${actor} -m "<what they are>"`]),
      );
    }
  }
  return lines;
}

/**
 * The person changes an interactive session's actor: the holds are released,
 * and in the vault the session runs in the new actor is held at once (a busy
 * one is said), as at a start. Refused, and nothing changes, for a headless
 * run or a name that writes in no vault.
 */
export async function switchActor(context: OperationContext, session: VaultSession, actor: string): Promise<Result<string, SwitchRefusal>> {
  if (session.mode === 'headless') return err({ reason: 'headless' });
  if (actor === session.actor) return ok(await describeWriting(context, session));
  // Every vault is looked at before anything changes, so a refused name leaves the session as it was.
  let writes = false;
  for (const vault of context.installation.vaults) writes ||= (await mayWrite(context, vault, actor, false)).ok;
  if (!writes) return err({ reason: 'writes-nowhere', actor });
  const left = session.actor === undefined ? [] : await leftUncommitted(context, session, session.actor);
  releaseHolds(context, session);
  session.worktrees.clear();
  session.actor = actor;
  logSession(context, session, { kind: 'actor', actor });
  const held = session.vault === undefined ? ok('') : await holdIn(context, session, session.vault);
  // Busy is worth saying here; a vault the new actor does not write in, the description says itself.
  const busy = !held.ok && held.error.reason === 'actor-busy' ? [refusalText(held.error, actor)] : [];
  return ok([await describeWriting(context, session), ...busy, ...left].join('\n'));
}
