// Which vaults the daemon runs, and which of them are paused (daemon.md
// "Hosting", "Integrity"; security.md "Unexpected changes").
//
// A vault's timer and Git-event jobs run here only when its accepted main
// says so: its `executor` names this installation, or it names none and the
// installation opts in with `host`. A vault whose `main` has an unaccepted
// change is paused: none of its events are matched, its timers do not fire
// and its queued work does not start, until an owner resolves it. Its owners
// are told once per unaccepted tip, through `builtin:notify`'s outbox, when
// they are recipient aliases of this installation; nothing is sent otherwise.
// `notifyOwners` is that one way of telling owners, used for every notice.

import { integrityStatus, acceptedIdentity, acceptedMain, unacceptedNotice, type AcceptedMain, type UnacceptedChange } from '../integrity/index.ts';
import { sendNotification } from '../notify/index.ts';
import { notifyDeps, scriptEnvironment, type OperationContext } from '../operations/index.ts';
import { hosting, type RegisteredVault, type VaultIdentity } from '../registry/index.ts';
import { newTraceId } from '../traces/index.ts';

/** The vaults whose timer and Git-event jobs run on this installation. */
export async function hostedVaults(context: OperationContext): Promise<RegisteredVault[]> {
  const hosted: RegisteredVault[] = [];
  for (const vault of context.installation.vaults) {
    const accepted = acceptedMain(context.state, vault.id);
    if (accepted === undefined) continue;
    const identity = await acceptedIdentity(context.reads, context.git, vault.path, accepted);
    if (identity.ok && hosting(vault, identity.value, context.installation.config.name).runsHere) hosted.push(vault);
  }
  return hosted;
}

/** The vaults among `vaults` whose `main` has an unaccepted change (or cannot be read): paused, with what is unaccepted. */
export async function pausedVaults(context: OperationContext, vaults: readonly RegisteredVault[]): Promise<Map<string, UnacceptedChange | undefined>> {
  const paused = new Map<string, UnacceptedChange | undefined>();
  for (const vault of vaults) {
    const status = await integrityStatus(context.git, context.state, vault);
    if (!status.ok) paused.set(vault.id, undefined);
    else if (status.value.state === 'unaccepted') paused.set(vault.id, status.value);
  }
  return paused;
}

/**
 * Tells the vault's owners about an unaccepted change, once per tip: the
 * outbox drops a repeat of the same key within its cooldown, and `told`
 * remembers it for as long as the daemon runs.
 */
export async function tellOwners(context: OperationContext, vault: RegisteredVault, change: UnacceptedChange, told: Set<string>): Promise<void> {
  const key = `unaccepted:${vault.id}:${change.tip ?? 'missing'}`;
  if (told.has(key) || change.accepted === undefined) return;
  told.add(key);
  await notifyOwners(context, vault, change.accepted, (review) => ({
    subject: `Vault "${vault.id}": an unaccepted change to main`, body: `${unacceptedNotice(change, review)}\n`, key,
  }));
}

/**
 * Sends a message to each of the vault's owners — as the accepted main names
 * them — who is a recipient alias of this installation; nothing when notify
 * is not configured. `key` lets the outbox drop a repeat within its cooldown.
 */
export async function notifyOwners(
  context: OperationContext, vault: RegisteredVault, accepted: AcceptedMain,
  message: (review: VaultIdentity['review']) => { subject: string; body: string; key: string },
): Promise<void> {
  const deps = notifyDeps(context, scriptEnvironment(context.installation));
  if (deps === undefined) return;
  const identity = await acceptedIdentity(context.reads, context.git, vault.path, accepted);
  if (!identity.ok) return;
  const { subject, body, key } = message(identity.value.review);
  const trace = newTraceId(context.ids);
  for (const owner of identity.value.owners.filter((o) => deps.config.recipients[o] !== undefined)) {
    await sendNotification(deps, { to: owner, subject, body, trace, key });
  }
}
