// A session's scratch directory (concepts.md "Script"): private working files
// for one session — a fan-out's saved results, a judge's batch — that belong
// in no vault and outlive no session. One directory per trace under the state
// directory, private to the user, removed when the session closes; the daemon
// sweeps what a crash left behind. Tools and builtins name files in it as
// `scratch:<name>`, and scripts find it as `VAULT_SCRATCH`.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, type InstallationPaths } from './platform.ts';

/** The environment variable a session's scripts find its scratch directory in. */
export const SCRATCH_VARIABLE = 'VAULT_SCRATCH';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A session's scratch directory, made if it is not there yet. */
export function scratchFor(paths: Pick<InstallationPaths, 'scratch'>, trace: string): string {
  const dir = join(paths.scratch, trace);
  ensurePrivateDir(dir);
  return dir;
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
