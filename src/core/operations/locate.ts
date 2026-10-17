// Which vault, actor and path a caller means (cli.md "Conventions"): the vault
// may be omitted when the caller is inside one — its checkout, or one of its
// actors' worktrees, which also names the actor — and a path may be written
// `<vault-id>:<path>`. Paths in a vault are relative to its root, with `/`,
// and never leave it.

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RegisteredVault } from '../registry/index.ts';

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** `inner` relative to `outer` with `/`, or undefined when it is not inside it. */
function inside(outer: string, inner: string): string | undefined {
  const rel = relative(real(outer), real(inner));
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

export interface Location {
  readonly vault: RegisteredVault;
  /** The actor whose worktree this is, when it is one. */
  readonly actor?: string;
  /** Where the directory is in the vault (`''` at its root). */
  readonly path: string;
}

/** The vault (and actor) whose checkout or worktree holds `directory`. */
export function locate(vaults: readonly RegisteredVault[], directory: string): Location | undefined {
  for (const vault of vaults) {
    const inWorktrees = inside(vault.worktrees, directory);
    if (inWorktrees !== undefined && inWorktrees !== '') {
      const [actor = '', ...rest] = inWorktrees.split('/');
      return { vault, actor, path: rest.join('/') };
    }
    const inVault = inside(vault.path, directory);
    if (inVault !== undefined) return { vault, path: inVault };
  }
  return undefined;
}

/** A path in a vault, normalised; undefined when it is empty after all, absolute, or leaves the vault. */
export function vaultRelative(path: string, from = ''): string | undefined {
  const parts: string[] = from === '' ? [] : from.split('/');
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\')) return undefined;
  for (const part of path.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? undefined : parts.join('/');
}

/** `<vault-id>:<path>` split into its registered vault and path; a text without a registered prefix is just a path. */
export function splitVaultPath(vaults: readonly RegisteredVault[], text: string): { vault?: RegisteredVault; path: string } {
  const colon = text.indexOf(':');
  if (colon > 0) {
    const vault = vaults.find((v) => v.id === text.slice(0, colon));
    if (vault !== undefined) return { vault, path: text.slice(colon + 1) };
  }
  return { path: text };
}
