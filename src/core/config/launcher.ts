// The `vault` launcher (cli.md "Installation of the command"): Pi does not put
// package executables on PATH, so an explicit command writes a small launcher
// to a user directory that usually is — `~/.local/bin/vault` on Linux and
// macOS, `%LOCALAPPDATA%\Microsoft\WindowsApps\vault.cmd` on Windows — that
// runs the package's CLI with the `node` found on PATH when it runs.
//
// Invariants: only a launcher this package wrote is ever replaced (it carries
// a marker line), never a `vault` of the user's; the program path is quoted so
// no shell reads it as more than a path, and a path `cmd.exe` cannot quote is
// refused.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { err, ok, type Result } from '../result/index.ts';
import { pathFor, type Host } from './platform.ts';

const MARKER = 'pi-active-vaults launcher';

export interface Launcher {
  readonly path: string;
  /** Whether its directory is on PATH, so `vault` runs as written. */
  readonly onPath: boolean;
  /** Whether an earlier launcher was replaced. */
  readonly replaced: boolean;
}

export type LauncherError =
  | { readonly reason: 'occupied'; readonly path: string }
  | { readonly reason: 'unsafe-path'; readonly program: string }
  | { readonly reason: 'no-directory'; readonly variable: string };

const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Where the launcher for `program` goes on `host`, and what it says. */
export function launcherFor(host: Host, program: string): Result<{ dir: string; file: string; text: string }, LauncherError> {
  const path = pathFor(host.os);
  if (host.os === 'win32') {
    const local = host.env['LOCALAPPDATA'];
    if (local === undefined || local === '') return err({ reason: 'no-directory', variable: 'LOCALAPPDATA' });
    if (/["%\r\n]/.test(program)) return err({ reason: 'unsafe-path', program });
    const dir = path.join(local, 'Microsoft', 'WindowsApps');
    return ok({ dir, file: path.join(dir, 'vault.cmd'), text: `@echo off\r\nREM ${MARKER}\r\nnode "${program}" %*\r\n` });
  }
  const dir = path.join(host.home, '.local', 'bin');
  return ok({ dir, file: path.join(dir, 'vault'), text: `#!/bin/sh\n# ${MARKER}\nexec node ${shellQuote(program)} "$@"\n` });
}

function onPath(host: Host, dir: string): boolean {
  const entries = (host.env['PATH'] ?? host.env['Path'] ?? '').split(host.os === 'win32' ? ';' : ':');
  const same = (a: string, b: string): boolean => (host.os === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return entries.some((entry) => same(entry.replace(/[\\/]+$/, ''), dir));
}

/** Writes the launcher for `program` (the CLI's entry point), replacing only an earlier launcher. */
export function writeLauncher(host: Host, program: string): Result<Launcher, LauncherError> {
  const launcher = launcherFor(host, program);
  if (!launcher.ok) return launcher;
  const { dir, file, text } = launcher.value;
  const replaced = existsSync(file);
  if (replaced && !readFileSync(file, 'utf8').includes(MARKER)) return err({ reason: 'occupied', path: file });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  if (host.os !== 'win32') chmodSync(file, 0o755);
  return ok({ path: file, onPath: onPath(host, dir), replaced });
}
