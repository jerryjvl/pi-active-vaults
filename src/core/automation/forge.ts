// Forge sync (daemon.md "Forge sync"): each tick, every `forge`-mode vault is
// fetched — the forge's `main` becomes the accepted main and the local `main`
// follows it forward, which is how merges are learnt of — and for the vaults
// this installation runs, each of the vault's actors' proposals is kept
// current at the forge: pushed, with its pull request opened or updated and
// its statuses published, when its head moves; its statuses published again
// every few minutes otherwise, to pick up reviews made in the forge.
//
// Invariants: everything that reaches the forge goes through `forge` — only
// actor branches and the package's notes are pushed, never `main`, and
// proposing is refused during an unaccepted change; a failure is kept as
// the vault's outcome for `status` and tried again on the next tick; what has
// been proposed is remembered only while the daemon runs, so a restart
// proposes each proposal once more (an update, not a second pull request).

import { readProposal } from '../actors/index.ts';
import { proposeToForge, publishStatuses, syncWithForge } from '../forge/index.ts';
import { acceptedIdentity } from '../integrity/index.ts';
import { forgeDeps, identityOf, type OperationContext } from '../operations/index.ts';
import type { RegisteredVault } from '../registry/index.ts';

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
        const synced = await syncWithForge(deps(), vault);
        if (!synced.ok) {
          outcomes.set(vault.id, { vault: vault.id, at, proposed: [], error: synced.error.reason });
          continue;
        }
        const accepted = synced.value.accepted;
        const kept = hosted.some((h) => h.id === vault.id) ? await proposeFor(vault, accepted, now.getTime()) : { proposed: [] };
        outcomes.set(vault.id, { vault: vault.id, at, accepted: accepted.sha, ...kept });
      }
    },
    outcomes: () => [...outcomes.values()],
  };
}
