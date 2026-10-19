// The vaults registered on this machine: where each lives, where its actors'
// worktrees go, what the catalog says about it, and whether this installation
// runs its jobs (daemon.md "Hosting").

import type { InstallationConfig, InstallationPaths, PlatformKind } from '../config/index.ts';
import { pathFor } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { VaultIdentity } from './identity.ts';

export interface RegisteredVault {
  readonly id: string;
  readonly path: string;
  /** The directory holding this vault's actor worktrees, one per actor. */
  readonly worktrees: string;
  /** This installation opts in to running the vault's jobs. */
  readonly host: boolean;
  /** The Git remote, by name in this clone, its forge (forge mode) or backup (local mode) is on. */
  readonly remote?: string;
}

/**
 * The registered vaults, in config order. A vault without configured worktrees
 * gets a directory of its own under the package's state directory, rather than
 * one beside the vault: no layout is imposed on the user's directories
 * (principle 13).
 */
export function registeredVaults(
  config: Pick<InstallationConfig, 'vaults'>, paths: Pick<InstallationPaths, 'worktrees'>, os: PlatformKind,
): RegisteredVault[] {
  return config.vaults.map((v) => ({
    id: v.id,
    path: v.path,
    worktrees: v.worktrees ?? pathFor(os).join(paths.worktrees, v.id),
    host: v.host,
    ...(v.remote === undefined ? {} : { remote: v.remote }),
  }));
}

/** A registration and the identity its root contract declares must agree, or nothing about the vault can be trusted. */
export function checkRegisteredIdentity(
  vault: RegisteredVault, identity: VaultIdentity,
): Result<void, { readonly reason: 'id-mismatch'; readonly registered: string; readonly declared: string }> {
  return identity.id === vault.id ? ok(undefined) : err({ reason: 'id-mismatch', registered: vault.id, declared: identity.id });
}

export interface CatalogEntry {
  readonly id: string;
  readonly summary: string;
  readonly useFor: readonly string[];
  readonly notFor: readonly string[];
  readonly audience: string;
}

/** What sessions are told about each vault, ordered by ID so the prompt is stable. */
export function catalog(identities: readonly VaultIdentity[]): CatalogEntry[] {
  return identities
    .map(({ id, purpose, audience }) => ({ id, summary: purpose.summary, useFor: purpose.useFor, notFor: purpose.notFor, audience }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether this installation runs the vault's timer and Git-event jobs: the
 * vault's `executor`, when set, decides alone; otherwise the installation
 * must opt in with `host`. `conflict` flags an opt-in the executor overrides.
 */
export function hosting(vault: RegisteredVault, identity: VaultIdentity, installationName: string): { runsHere: boolean; conflict: boolean } {
  if (identity.executor === undefined) return { runsHere: vault.host, conflict: false };
  const runsHere = identity.executor === installationName;
  return { runsHere, conflict: vault.host && !runsHere };
}
