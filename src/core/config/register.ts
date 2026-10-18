// Registering a vault in the installation config (`vault init`, `vault add`).
//
// The file is the user's: it is edited as a YAML document, so comments,
// ordering and layout survive, and the one change is a new entry under
// `vaults` — or, when there is no file yet, the file itself, with the
// installation's person. Invariants:
//  - an invalid config is never edited — its problems are reported instead;
//  - an id or path already registered is refused, never replaced;
//  - the edited text must load as a valid config before it is written, so an
//    invalid entry never reaches the file;
//  - the file is replaced atomically (written beside it, then renamed) and is
//    private to the user.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { err, ok, type Result } from '../result/index.ts';
import { parseInstallationConfig, type ConfigError } from './installation.ts';
import { ensurePrivateDir, type Host } from './platform.ts';

export interface NewVaultEntry {
  readonly id: string;
  readonly path: string;
  readonly worktrees?: string;
  readonly host?: boolean;
}

export type RegisterError =
  | Extract<ConfigError, { reason: 'unreadable' | 'invalid-yaml' | 'invalid' }>
  | { readonly reason: 'already-registered'; readonly id: string }
  /** `id` is the vault already registered at that path. */
  | { readonly reason: 'path-registered'; readonly id: string }
  | { readonly reason: 'unwritable'; readonly code: string };

/** The file's text, or undefined when there is no file. */
function currentText(file: string): Result<string | undefined, RegisterError> {
  try {
    return ok(readFileSync(file, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' ? ok(undefined) : err({ reason: 'unreadable', code, path: file } as RegisterError);
  }
}

export type PersonError = { readonly reason: 'invalid-person'; readonly person: string };

/** Whether `person` can be `installation.person`: the config's own rule, applied before anything is made. */
export function checkPerson(person: string, host: Host): Result<string, PersonError> {
  return parseInstallationConfig(stringify({ installation: { person } }), host).ok ? ok(person) : err({ reason: 'invalid-person', person });
}

/**
 * Adds the vault to the config. When there is no config file, creates it —
 * its directory private too — with `installation.person` as `person` says; a
 * file that exists is never given one.
 */
export function registerVault(file: string, host: Host, entry: NewVaultEntry, person?: string): Result<void, RegisterError> {
  const found = currentText(file);
  if (!found.ok) return found;
  const text = found.value ?? '';
  const current = parseInstallationConfig(text, host);
  if (!current.ok) return err(current.error as RegisterError);

  // The entry on its own first: its problems, and its path as the config reads it.
  const item = { id: entry.id, path: entry.path, ...(entry.worktrees === undefined ? {} : { worktrees: entry.worktrees }), ...(entry.host === true ? { host: true } : {}) };
  const alone = parseInstallationConfig(stringify({ vaults: [item] }), host);
  if (!alone.ok) return err(alone.error as RegisterError);
  const sameId = current.value.vaults.find((v) => v.id === entry.id);
  if (sameId !== undefined) return err({ reason: 'already-registered', id: sameId.id });
  const samePath = current.value.vaults.find((v) => v.path === alone.value.vaults[0]?.path);
  if (samePath !== undefined) return err({ reason: 'path-registered', id: samePath.id });

  const document = parseDocument(text);
  if (found.value === undefined && person !== undefined) document.setIn(['installation', 'person'], person);
  if (document.hasIn(['vaults'])) document.addIn(['vaults'], document.createNode(item));
  else document.setIn(['vaults'], document.createNode([item]));
  const edited = document.toString();
  const next = parseInstallationConfig(edited, host);
  if (!next.ok) return err(next.error as RegisterError);

  const temporary = `${file}.${process.pid}.new`;
  try {
    ensurePrivateDir(dirname(file));
    writeFileSync(temporary, edited, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    return err({ reason: 'unwritable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
  }
  return ok(undefined);
}
