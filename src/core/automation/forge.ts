// Forge sync (daemon.md "Forge sync"): each tick, every `forge`-mode vault is
// fetched — the forge's `main` becomes the accepted main and the local `main`
// follows it forward, which is how merges are learnt of — and for the vaults
// this installation runs, each of the vault's actors' proposals is kept
// current at the forge: pushed, with its pull request opened or updated and
// its statuses published, when its head moves; its statuses published again
// every few minutes otherwise, to pick up reviews made in the forge — and
// each proposal merged in the forge is checked for its commits reaching
// `main` (forge/merges.ts); one that did not is told to the owners once.
//
// Invariants: everything that reaches the forge goes through `forge` — only
// actor branches and the package's notes are pushed, never `main`, and
// proposing is refused during an unaccepted change; a failure is kept as
// the vault's outcome for `status` and tried again on the next tick; what has
// been proposed is remembered only while the daemon runs, so a restart
// proposes each proposal once more (an update, not a second pull request).

import { readProposal } from '../actors/index.ts';
import { checkMerges, lostMergeText, proposeToForge, publishStatuses, syncWithForge, uncheckedMerges, type MergedProposal } from '../forge/index.ts';
import { acceptedIdentity, type AcceptedMain } from '../integrity/index.ts';
import { forgeDeps, identityOf, type OperationContext } from '../operations/index.ts';
import { writersOf, type RegisteredVault } from '../registry/index.ts';
import { notifyOwners } from './vaults.ts';

/** How long a proposal's statuses stand before they are published again. */
const STATUS_REFRESH_MS = 5 * 60_000;

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
  const current = new Map<string, { head: string; published: number }>();
  const outcomes = new Map<string, ForgeOutcome>();
  const deps = () => forgeDeps(context, context.installation.config.person ?? 'vault');

  const proposeFor = async (vault: RegisteredVault, accepted: Parameters<typeof readProposal>[2], now: number): Promise<{ proposed: string[]; error?: string }> => {
    const identity = await acceptedIdentity(context.reads, context.git, vault.path, accepted);
    if (!identity.ok) return { proposed: [], error: identity.error.reason };
    const proposed: string[] = [];
    let error: string | undefined;
    for (const actor of identity.value.actors) {
      const key = `${vault.id}\0${actor}`;
      const proposal = await readProposal(context.git, vault.path, accepted, actor);
      if (!proposal.ok) {
        current.delete(key);
        if (proposal.error.reason !== 'no-proposal') error ??= proposal.error.reason;
        continue;
      }
      const last = current.get(key);
      if (last?.head !== proposal.value.head) {
        const pushed = await proposeToForge(deps(), vault, actor);
        if (!pushed.ok) {
          error ??= pushed.error.reason;
          continue;
        }
        current.set(key, { head: proposal.value.head, published: now });
      } else if (now - last.published >= STATUS_REFRESH_MS) {
        const published = await publishStatuses(deps(), vault, actor);
        if (!published.ok) {
          error ??= published.error.reason;
          continue;
        }
        last.published = now;
      }
      proposed.push(actor);
    }
    return { proposed, ...(error === undefined ? {} : { error }) };
  };

  /** Judges the merges asked about before fetching against the main fetched; tells the owners of those that lost their commits. */
  const judgeMerges = async (vault: RegisteredVault, accepted: AcceptedMain, merges: readonly MergedProposal[]): Promise<string | undefined> => {
    if (merges.length === 0) return undefined;
    const checked = await checkMerges(deps(), vault, accepted, merges);
    if (!checked.ok) return checked.error.reason;
    const lost = checked.value.filter((r) => !r.kept);
    if (lost.length > 0) {
      await notifyOwners(context, vault, accepted, () => ({
        subject: `Vault "${vault.id}": a merged proposal lost its commits`,
        body: `${lost.map(lostMergeText).join('\n')}\nDisable squash and rebase merges in the forge (security-setup.md).\n`,
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
        const kept = runsHere ? await proposeFor(vault, accepted, now.getTime()) : { proposed: [] };
        const error = judged ?? kept.error;
        outcomes.set(vault.id, { vault: vault.id, at, accepted: accepted.sha, proposed: kept.proposed, ...(error === undefined ? {} : { error }) });
      }
    },
    outcomes: () => [...outcomes.values()],
  };
}
