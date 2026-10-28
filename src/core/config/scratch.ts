// A session's scratch directory (concepts.md "Script"): private working files
// for one session — a fan-out's saved results, a judge's batch — that belong
// in no vault and outlive no session. One directory per trace under the state
// directory, private to the user, removed when the session closes; the daemon
// sweeps what a crash left behind. Tools and builtins name files in it as
// `scratch:<name>`, and scripts find it as `VAULT_SCRATCH`.
//
// Invariants: a trace is issued once, and its directory is claimed once, when
// the session opens, with a create that fails if the directory is there — so
// two sessions never share one, even by accident, and none inherits a stale
// one. Afterwards it is only looked up, never made. A fan-out's workspace
// (`workspace`) is likewise always new, named by the package rather than the
// caller, and claimed the same way inside the session's directory.

import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';
import { ensurePrivateDir, landsWithin, type InstallationPaths } from './platform.ts';

/** The environment variable a session's scripts find its scratch directory in. */
export const SCRATCH_VARIABLE = 'VAULT_SCRATCH';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Makes `dir` (its parent exists) if it is not there; an error, never the existing one, if it is. */
function claimDir(dir: string): Result<string, string> {
  try {
    mkdirSync(dir, { mode: 0o700 });
    return ok(dir);
  } catch (error) {
    return err((error as NodeJS.ErrnoException).code === 'EEXIST' ? `${dir} already exists` : `${dir} cannot be made`);
  }
}

/** Claims a new session's scratch directory: made now, or an error when one is already there for its trace. */
export function claimScratch(paths: Pick<InstallationPaths, 'scratch'>, trace: string): Result<string, string> {
  ensurePrivateDir(paths.scratch);
  return claimDir(join(paths.scratch, trace));
}

/** An open session's scratch directory, as claimed when it opened; undefined when there is none. */
export function scratchFor(paths: Pick<InstallationPaths, 'scratch'>, trace: string): string | undefined {
  const dir = join(paths.scratch, trace);
  try {
    return lstatSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

export function removeScratch(paths: Pick<InstallationPaths, 'scratch'>, trace: string): void {
  rmSync(join(paths.scratch, trace), { recursive: true, force: true });
}

/** Removes the scratch directories left untouched for longer than `maxAgeMs` (a session that ended without closing). */
export function sweepScratch(paths: Pick<InstallationPaths, 'scratch'>, now: number, maxAgeMs: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(paths.scratch);
  } catch {
    return [];
  }
  return entries.filter((entry) => {
    const dir = join(paths.scratch, entry);
    try {
      if (now - statSync(dir).mtimeMs <= maxAgeMs) return false;
    } catch {
      return false;
    }
    rmSync(dir, { recursive: true, force: true });
    return true;
  });
}

/**
 * The file a `scratch:<name>` reference names in `scratch`: a plain file name,
 * never a path, so nothing can be reached outside it. Undefined for anything
 * else, or when there is no scratch directory.
 */
export function scratchFile(scratch: string | undefined, reference: string): string | undefined {
  if (scratch === undefined || !reference.startsWith('scratch:')) return undefined;
  const name = reference.slice('scratch:'.length);
  return NAME.test(name) && name !== '.' && name !== '..' ? join(scratch, name) : undefined;
}

// --- A fan-out's workspace ---------------------------------------------------

/** What one item's workspace holds at most, seeded or written: a bound on what a worker can leave behind. */
export const WORKSPACE_LIMITS = { files: 64, bytes: 16 * 1024 * 1024 } as const;

/**
 * A fan-out's new workspace in the session's scratch directory: `fanout-<id>`,
 * with one directory per item, `1`, `2`, … in the items' order. When `seed`
 * (a directory in scratch a script prepared) has a directory of the same
 * number, its regular files are copied in, links and anything else left out;
 * the seed itself is never written. Returns the workspace's name in scratch
 * and each item's directory.
 */
export function newWorkspace(scratch: string, id: string, items: number, seed?: string): Result<{ name: string; dirs: string[] }, string> {
  const name = `fanout-${id}`;
  const made = claimDir(join(scratch, name));
  if (!made.ok) return made;
  const dirs: string[] = [];
  for (let n = 1; n <= items; n++) {
    const dir = join(made.value, String(n));
    const item = claimDir(dir);
    if (!item.ok) return item;
    if (seed !== undefined) {
      const copied = copyTree(join(seed, String(n)), dir, { files: 0, bytes: 0 });
      if (!copied.ok) return err(`the seed for item ${n}: ${copied.error}`);
    }
    dirs.push(dir);
  }
  return ok({ name, dirs });
}

/** Copies the regular files and directories under `from` (when it is a real directory) into `to`, within the limits. */
function copyTree(from: string, to: string, count: { files: number; bytes: number }): Result<void, string> {
  let entries: string[];
  try {
    if (!lstatSync(from).isDirectory()) return ok(undefined);
    entries = readdirSync(from);
  } catch {
    return ok(undefined);
  }
  for (const entry of entries) {
    const source = join(from, entry);
    const target = join(to, entry);
    const stat = lstatSync(source);
    if (stat.isDirectory()) {
      mkdirSync(target, { mode: 0o700 });
      const inner = copyTree(source, target, count);
      if (!inner.ok) return inner;
    } else if (stat.isFile()) {
      count.files += 1;
      count.bytes += stat.size;
      if (count.files > WORKSPACE_LIMITS.files || count.bytes > WORKSPACE_LIMITS.bytes) return err(`more than ${WORKSPACE_LIMITS.files} files or ${WORKSPACE_LIMITS.bytes} bytes`);
      copyFileSync(source, target);
    }
  }
  return ok(undefined);
}

/** A seed reference's directory: `scratch:<name>`, a real directory there; undefined for anything else. */
export function seedDir(scratch: string | undefined, reference: string): string | undefined {
  const dir = scratchFile(scratch, reference);
  try {
    return dir !== undefined && lstatSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a worker may write `content` to `path`: the path must really land in
 * its own directory (links followed, so none leads out), must not be a link,
 * the workspace must stay within its limits, and a `.json` file must parse —
 * refused at the write, with why, so the worker can fix it in the same session.
 */
export function workspaceWrite(dir: string, path: string, content: string): Result<void, string> {
  if (landsWithin(dir, path) === undefined) return err(`${path} is outside your workspace (${dir}); write only there`);
  try {
    if (lstatSync(path).isSymbolicLink()) return err(`${path} is a link; write only regular files`);
  } catch {
    // Not there yet: a new file.
  }
  const { files, bytes } = sizeOf(dir, path);
  if (files + 1 > WORKSPACE_LIMITS.files || bytes + Buffer.byteLength(content) > WORKSPACE_LIMITS.bytes) return err(`your workspace may hold at most ${WORKSPACE_LIMITS.files} files and ${WORKSPACE_LIMITS.bytes} bytes`);
  if (path.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(content);
    } catch (error) {
      return err(`${path} would not be valid JSON (${error instanceof Error ? error.message : String(error)}); nothing was written, so write it again, corrected`);
    }
  }
  return ok(undefined);
}

/** The files and bytes under `dir`, leaving out `except` (the file about to be replaced). */
function sizeOf(dir: string, except: string): { files: number; bytes: number } {
  const total = { files: 0, bytes: 0 };
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (path !== except) {
        total.files += 1;
        total.bytes += stat.size;
      }
    }
  };
  walk(dir);
  return total;
}
