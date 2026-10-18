// A machine where nothing is installed yet: an empty home, no config file, no
// state, and the CLI running on it — what a first `vault init` meets. Never
// touches the developer's home.

import type { Host } from '../../src/core/config/index.ts';
import { cliOn, type CliOptions, type Ran } from './cli.ts';
import { fakeClock, type FakeClock } from './clock.ts';
import { createTempRepo, type TempRepo } from './git-repo.ts';
import { hostFor } from './installation.ts';
import { createTempDir, type TempDir } from './temp-dir.ts';

export interface EmptyHome {
  readonly dir: TempDir;
  readonly host: Host;
  readonly clock: FakeClock;
  /** The config file the package would create. */
  readonly configFile: string;
  /** Runs `vault …` on the machine, from the home directory unless told otherwise. */
  vault(...argv: string[]): Promise<Ran>;
  /** The same, with options (`cwd`, `io`, …). */
  vaultWith(options: CliOptions): (...argv: string[]) => Promise<Ran>;
  /** A repository for the Git environment, and a place to make vaults to add. */
  readonly scratch: TempRepo;
}

export function withEmptyHome(run: (home: EmptyHome) => Promise<void>, env: Record<string, string> = {}): () => Promise<void> {
  return async () => {
    const dir = createTempDir('pav-home-');
    const scratch = createTempRepo();
    try {
      const host = hostFor(dir, scratch, env);
      const clock = fakeClock();
      const target = { host, cwd: dir.path, gitEnv: scratch.env, clock, alive: async () => ({ ok: true as const, value: undefined }) };
      await run({
        dir, host, clock, scratch,
        configFile: dir.file('config', 'config.yaml'),
        vault: cliOn(target),
        vaultWith: (options) => cliOn(target, options),
      });
    } finally {
      scratch.cleanup();
      dir.cleanup();
    }
  };
}
