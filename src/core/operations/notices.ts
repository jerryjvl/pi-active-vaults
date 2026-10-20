// The unaccepted-change notice (security.md "Unexpected changes"): every
// surface reports each vault whose `main` differs from its accepted `main` —
// the CLI on every command, Pi with every result for the vault, MCP with every
// response for it — until an owner adopts the change or resets `main`. The
// notice says how to resolve it in the vault's review mode, read from the
// accepted `main` (or `main` itself when nothing was accepted yet).

import type { Git } from '../git/index.ts';
import { UNCACHED_READS, acceptedIdentity, integrityStatus, unacceptedNotice, type AcceptedReads, type UnacceptedChange } from '../integrity/index.ts';
import { readVaultIdentity, type RegisteredVault, type ReviewMode } from '../registry/index.ts';
import type { Queryable } from '../store/index.ts';

export interface VaultNotice {
  readonly vault: string;
  readonly notice: string;
  readonly change: UnacceptedChange;
}

type NoticeContext = { readonly git: Git; readonly state: Queryable; readonly reads?: AcceptedReads };

async function reviewMode(context: NoticeContext, change: UnacceptedChange, vault: RegisteredVault): Promise<ReviewMode> {
  const { accepted, tip } = change;
  const identity = accepted !== undefined ? await acceptedIdentity(context.reads ?? UNCACHED_READS, context.git, vault.path, accepted)
    : tip !== null ? await readVaultIdentity(context.git, vault.path, tip)
    : undefined;
  return identity?.ok === true ? identity.value.review : 'local';
}

/** The notice for each of `vaults` with an unaccepted change, in order; a vault that cannot be read gets one too. */
export async function unacceptedNotices(context: NoticeContext, vaults: readonly RegisteredVault[]): Promise<VaultNotice[]> {
  const notices: VaultNotice[] = [];
  for (const vault of vaults) {
    const status = await integrityStatus(context.git, context.state, vault);
    if (!status.ok) {
      const change: UnacceptedChange = { state: 'unaccepted', vault: vault.id, path: vault.path, change: 'main-missing', tip: null, commits: [] };
      notices.push({ vault: vault.id, change, notice: `Vault "${vault.id}": its repository at ${vault.path} cannot be read (${status.error.reason}). Automation is paused for this vault.` });
      continue;
    }
    if (status.value.state === 'accepted') continue;
    notices.push({ vault: vault.id, change: status.value, notice: unacceptedNotice(status.value, await reviewMode(context, status.value, vault)) });
  }
  return notices;
}
