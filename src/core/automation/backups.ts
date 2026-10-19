// Backups (daemon.md "Backups"): each tick, every local-mode vault whose
// registration names a remote is pushed there when its refs changed since the
// last push (backup/backup.ts) — `main` and the notes fast-forward only, actor
// branches forced, nothing pruned. A forge-mode vault's remote is its forge,
// which forge sync keeps.
//
// Invariants: what was last pushed is remembered only while the daemon runs,
// so a restart pushes once more (finding nothing new to send); a failure — a
// remote missing from this clone, a backup that has diverged — is kept as the
// vault's outcome for `daemon status` and `doctor`, and tried again on the
// next tick.

import { backupVault } from '../backup/index.ts';
import { identityOf, type OperationContext } from '../operations/index.ts';
import type { RegisteredVault } from '../registry/index.ts';

export interface BackupStatus {
  readonly vault: string;
  readonly remote: string;
  readonly at: string;
  /** When it last pushed something. */
  readonly pushed?: string;
  readonly error?: string;
}

export interface Backups {
  tick(vaults: readonly RegisteredVault[]): Promise<void>;
  outcomes(): BackupStatus[];
}

export function createBackups(context: OperationContext): Backups {
  const last = new Map<string, string>();
  const outcomes = new Map<string, BackupStatus>();

  const backup = async (vault: RegisteredVault & { remote: string }): Promise<void> => {
    const at = context.clock.now().toISOString();
    const previous = outcomes.get(vault.id);
    const keep = (error?: string, pushed = previous?.pushed): void => {
      outcomes.set(vault.id, { vault: vault.id, remote: vault.remote, at, ...(pushed === undefined ? {} : { pushed }), ...(error === undefined ? {} : { error }) });
    };
    // Only a vault with an accepted main, in local mode: a forge-mode vault's remote is its forge.
    const identity = await identityOf(context, vault);
    if (!identity.ok || identity.value.review !== 'local') return;
    const done = await backupVault(context.git, vault, last.get(vault.id));
    if (!done.ok) {
      keep(done.error.reason === 'missing-remote' ? `this clone has no remote "${vault.remote}" (vault doctor says what to do)`
        : done.error.reason === 'push-refused' ? `refused: ${done.error.detail}` : done.error.reason);
      return;
    }
    last.set(vault.id, done.value.state);
    keep(undefined, done.value.outcome === 'pushed' ? at : previous?.pushed);
  };

  return {
    async tick(vaults) {
      for (const vault of vaults) if (vault.remote !== undefined) await backup({ ...vault, remote: vault.remote });
    },
    outcomes: () => [...outcomes.values()],
  };
}
