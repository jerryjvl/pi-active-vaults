// Taint (extension.md "Taint", concepts.md "Merge policy"): a session is
// tainted once it uses a tool not in the installation's `taint.trusted-tools`,
// or reads a file outside the registered vaults — so its commits carry
// `Vault-Tainted` and merge rules' `when-tainted` requirements apply.
//
// Fails closed: an unknown tool is untrusted, and no list means every tool
// taints. A read counts as inside a vault only where it really lands — a
// link inside a vault can lead outside it.

import { landsWithin } from '../config/index.ts';
import type { InstallationConfig } from '../config/index.ts';
import type { RegisteredVault } from '../registry/index.ts';

/** A tool call as taint sees it: the tool, and the files it reads (absolute paths). */
export interface TaintedCall {
  readonly tool: string;
  readonly reads?: readonly string[];
}

function insideVaults(vaults: readonly RegisteredVault[], path: string): boolean {
  return vaults.some((v) => landsWithin(v.path, path) !== undefined || landsWithin(v.worktrees, path) !== undefined);
}

/** Whether the call taints the session. */
export function taints(taint: InstallationConfig['taint'], vaults: readonly RegisteredVault[], call: TaintedCall): boolean {
  if (!taint.trustedTools.includes(call.tool)) return true;
  return (call.reads ?? []).some((path) => !insideVaults(vaults, path));
}
