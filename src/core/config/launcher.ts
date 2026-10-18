// The `vault` launcher (cli.md "Installation of the command"): Pi does not put
// package executables on PATH, so an explicit command writes a small launcher
// to a user directory that usually is — `~/.local/bin/vault` on Linux and
// macOS, `%LOCALAPPDATA%\Microsoft\WindowsApps\vault.cmd` on Windows — that
// runs the package's CLI with the `node` found on PATH when it runs.
//
// Invariants: only a launcher this package wrote is ever replaced (it carries
// a marker line), never a `vault` of the user's; the program path is quoted so
// no shell reads it as more than a path, and a path `cmd.exe` cannot quote is
// refused. It also says which other `vault` is on PATH and which one runs when
// the name is typed — the first on PATH, whichever that is.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { err, ok, type Result } from '../result/index.ts';
import { pathEntries, pathFor, systemFiles, type FileView, type Host } from './platform.ts';

const MARKER = 'pi-active-vaults launcher';

export interface Launcher {
  readonly path: string;
  /** Whether its directory is on PATH, so `vault` runs as written. */
  readonly onPath: boolean;
  /** Whether an earlier launcher was replaced. */
  readonly replaced: boolean;
  /** Every other `vault` on PATH, in PATH order. */
  readonly others: readonly string[];
  /** The file that typing `vault` runs: the first on PATH (this launcher only when its directory comes before every other `vault`); undefined when there is none. */
  readonly runs: string | undefined;
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

const sameName = (host: Host) => (a: string, b: string): boolean => (host.os === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const withoutSeparator = (dir: string): string => dir.replace(/[\\/]+$/, '');

function onPath(host: Host, dir: string): boolean {
  const same = sameName(host);
  return pathEntries(host).some((entry) => same(withoutSeparator(entry), dir));
}

/**
 * The other files called `vault` along PATH, in order, each as its directory
 * names it, and the one that runs when the name is typed: the first on PATH,
 * the launcher at `launcher` included where its directory is on PATH.
 */
export function vaultsOnPath(host: Host, launcher: string, files: FileView = systemFiles): { others: string[]; runs: string | undefined } {
  const path = pathFor(host.os);
  const same = sameName(host);
  const names = host.os === 'win32' ? ['vault.cmd', 'vault.exe', 'vault.bat'] : ['vault'];
  const launcherDir = path.dirname(launcher);
  const others: string[] = [];
  let runs: string | undefined;
  for (const entry of pathEntries(host)) {
    const dir = withoutSeparator(entry);
    const file = same(dir, launcherDir) ? launcher : names.map((name) => path.join(dir, name)).find((candidate) => files.exists(candidate));
    if (file === undefined) continue;
    runs ??= file;
    if (!same(file, launcher) && !others.some((o) => same(o, file))) others.push(file);
  }
  return { others, runs };
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
  return ok({ path: file, onPath: onPath(host, dir), replaced, ...vaultsOnPath(host, file) });
}

/** What `install-cli` tells the person: where the launcher is, whether its name will find it, and any other `vault` on PATH. */
export function describeLauncher(launcher: Launcher): string {
  const { path, onPath: reachable, others, runs } = launcher;
  const dir = path.replace(/[\\/][^\\/]*$/, '');
  const lines = [`Wrote ${path}.${reachable ? '' : ' Its directory is not on PATH yet; add it to run "vault" by name.'}`];
  if (others.length === 0) return lines.join(' ');
  if (runs === path) lines.push(`The launcher comes first on PATH, so it runs; ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} behind it.`);
  else if (reachable) lines.push(`${runs ?? ''} comes first on PATH, so it runs, not this launcher; also on PATH: ${others.filter((o) => o !== runs).join(', ') || 'nothing else'}. Put ${dir} before ${runs ?? 'it'} on PATH, or remove that vault, to run the launcher.`);
  else lines.push(`${runs ?? ''} is the vault that runs now${others.length > 1 ? `; also on PATH: ${others.filter((o) => o !== runs).join(', ')}` : ''}.`);
  return lines.join(' ');
}
