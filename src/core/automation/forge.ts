// Forge sync (daemon.md "Forge sync"): each tick, every `forge`-mode vault is
// fetched — the forge's `main` becomes the accepted main and the local `main`
// follows it forward, which is how merges are learnt of — and for the vaults
// this installation runs, each of the vault's actors' proposals is kept
// current at the forge: pushed, with its pull request opened or updated and
// its statuses published, when its head moves; its statuses published again
// every few minutes otherwise, to pick up reviews made in the forge, and every
// minute while all it waits for is an owner's approval. The person's own
// proposal, in every forge vault they write to (run here or not), is never
// pushed from here — proposing it is theirs (`vault propose`) — but once the
// forge holds it its statuses are kept current the same way — and
// each proposal merged in the forge is checked for its commits reaching
// `main` (forge/merges.ts); one that did not is told to the owners once, and
// its actor's branch — which still holds the commits `main` lacks — is reset
// to `main` when that loses nothing, left as it is when not. A branch that
// still holds a lost merge's head is not proposed again.
//
// Invariants: everything that reaches the forge goes through `forge` — only
// actor branches and the package's notes are pushed, never `main`, and
// proposing is refused during an unaccepted change; a failure is kept as
// the vault's outcome for `status` and tried again on the next tick; what has
// been proposed is remembered only while the daemon runs, so a restart
// proposes each proposal once more (an update, not a second pull request) —
// which is why a lost merge is kept in the state store and its branch judged
// from Git, not from what this module remembers.

import { readProposal, resetActorBranch, type ResetOutcome } from '../actors/index.ts';
import { checkMerges, lostMergeNotice, lostMerges, proposeToForge, publishStatuses, syncWithForge, uncheckedMerges, type MergedProposal } from '../forge/index.ts';
import { acceptedIdentity, type AcceptedMain } from '../integrity/index.ts';
import { forgeDeps, identityOf, judgeForProposal, type OperationContext } from '../operations/index.ts';
import { writersOf, type RegisteredVault } from '../registry/index.ts';
import { notifyOwners } from './vaults.ts';

/** How long a proposal's statuses stand before they are published again. */
const STATUS_REFRESH_MS = 5 * 60_000;
/** ...and while all it waits for is an owner's approval in the forge: each tick, so a merge is not held up for minutes. */
const AWAITING_OWNER_REFRESH_MS = 60_000;

export interface ForgeOutcome {
  readonly vault: string;
  readonly at: string;
  /** The accepted main after fetching. */
  readonly accepted?: string;
  /** The actors whose proposals are current at the forge. */
  readonly proposed: readonly string[];
  /** What failed, if anything did: the first failure. */
  readonly error?: string;
}

export interface ForgeSync {
  /** Syncs every forge-mode vault, proposing for those in `hosted`. */
  tick(hosted: readonly RegisteredVault[]): Promise<void>;
  outcomes(): ForgeOutcome[];
}

export function createForgeSync(context: OperationContext): ForgeSync {
  const current = new Map<string, { head: string; published: number; awaitingOwner: boolean }>();
  const outcomes = new Map<string, ForgeOutcome>();
  const deps = () => forgeDeps(context, context.installation.config.person ?? 'vault');

  const proposeFor = async (vault: RegisteredVault, accepted: Parameters<typeof readProposal>[2], now: number, runsHere: boolean): Promise<{ proposed: string[]; error?: string }> => {
    const identity = await acceptedIdentity(context.reads, context.git, vault.path, accepted);
    if (!identity.ok) return { proposed: [], error: identity.error.reason };
    const person = context.installation.config.person;
    const actors = runsHere ? identity.value.actors : [];
    const own = person !== undefined && writersOf(identity.value).includes(person) && !actors.includes(person) ? [person] : [];
    const proposed: string[] = [];
    let error: string | undefined;
    // A branch that still holds what the forge merged without its commits is not a new proposal.
    const merged = new Set((await lostMerges(context.git, context.state, vault)).map((r) => r.actor));
    for (const actor of [...actors, ...own]) {
      const mine = own.includes(actor);
      const key = `${vault.id}\0${actor}`;
      if (merged.has(actor)) {
        current.delete(key);
        continue;
      }
      const proposal = await readProposal(context.git, vault.path, accepted, actor);
      if (!proposal.ok) {
        current.delete(key);
        if (proposal.error.reason !== 'no-proposal') error ??= proposal.error.reason;
        continue;
      }
      // What the proposal still needs judged is judged before its statuses go out, so `vault/policy` counts it;
      // a judgement already recorded for the same content is reused, so a republish asks no model. The person's
      // own proposal was judged when they proposed it, and work they have not proposed is not judged here.
      if (!mine) await judgeForProposal(context, vault, actor, actor);
      const last = current.get(key);
      const moved = last?.head !== proposal.value.head;
      const due = last === undefined || now - last.published >= (last.awaitingOwner ? AWAITING_OWNER_REFRESH_MS : STATUS_REFRESH_MS);
      if (!moved && !due) {
        proposed.push(actor);
        continue;
      }
      const sent = moved && !mine ? await proposeToForge(deps(), vault, actor) : await publishStatuses(deps(), vault, actor);
      if (!sent.ok) {
        if (sent.error.reason === 'not-proposed') {
          // The person's: not yet proposed, or committed to since — nothing to keep current until they propose it;
          // asked again next tick. An actor's whose pull request was closed in the forge: proposed again only when
          // its head moves, as before.
          if (mine) current.delete(key);
          else current.set(key, { head: proposal.value.head, published: now, awaitingOwner: false });
        } else error ??= sent.error.reason;
        continue;
      }
      const awaitingOwner = sent.value.unmet.length === 1 && sent.value.unmet[0] === 'owner';
      current.set(key, { head: proposal.value.head, published: now, awaitingOwner });
      proposed.push(actor);
    }
    return { proposed, ...(error === undefined ? {} : { error }) };
  };

  /** Judges the merges asked about before fetching against the main fetched; resets the branches of those that lost their commits where that loses nothing, and tells the owners. */
  const judgeMerges = async (vault: RegisteredVault, accepted: AcceptedMain, merges: readonly MergedProposal[]): Promise<string | undefined> => {
    if (merges.length === 0) return undefined;
    const checked = await checkMerges(deps(), vault, accepted, merges);
    if (!checked.ok) return checked.error.reason;
    const lost = checked.value.filter((r) => !r.kept);
    if (lost.length > 0) {
      const resets = new Map<number, ResetOutcome | undefined>();
      for (const r of lost) {
        const reset = await resetActorBranch({ git: context.git, store: context.state, alive: context.alive }, vault, accepted, r.actor, r.head);
        resets.set(r.pull, reset.ok ? reset.value : undefined);
      }
      const standing = await lostMerges(context.git, context.state, vault);
      await notifyOwners(context, vault, accepted, () => ({
        subject: `Vault "${vault.id}": a merged proposal lost its commits`,
        body: `${lost.map((r) => lostMergeNotice(r, vault, resets.get(r.pull), standing.find((s) => s.pull === r.pull))).join('\n')}\nDisable squash and rebase merges in the forge (security-setup.md).\n`,
        key: `merges:${vault.id}:${lost.map((r) => r.pull).join(',')}`,
      }));
    }
    return undefined;
  };

  return {
    async tick(hosted) {
      const now = context.clock.now();
      for (const vault of context.installation.vaults) {
        const identity = await identityOf(context, vault);
        if (!identity.ok || identity.value.review !== 'forge') {
          outcomes.delete(vault.id);
          continue;
        }
        const at = now.toISOString();
        const runsHere = hosted.some((h) => h.id === vault.id);
        // Asked before fetching, so every merge named is in the main fetched next.
        const asked = runsHere ? await uncheckedMerges(deps(), vault, writersOf(identity.value)) : undefined;
        const synced = await syncWithForge(deps(), vault);
        if (!synced.ok) {
          outcomes.set(vault.id, { vault: vault.id, at, proposed: [], error: synced.error.reason });
          continue;
        }
        const accepted = synced.value.accepted;
        const judged = asked === undefined ? undefined : asked.ok ? await judgeMerges(vault, accepted, asked.value) : asked.error.reason;
        const kept = await proposeFor(vault, accepted, now.getTime(), runsHere);
        const error = judged ?? kept.error;
        outcomes.set(vault.id, { vault: vault.id, at, accepted: accepted.sha, proposed: kept.proposed, ...(error === undefined ? {} : { error }) });
      }
    },
    outcomes: () => [...outcomes.values()],
  };
}
