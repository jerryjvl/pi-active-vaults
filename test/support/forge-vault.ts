// A forge-mode vault for tests: its `origin` is a local bare repository
// behind the forge's URL, beside a stub forge API (forge-stub.ts) — so pushes
// and fetches are real Git, and the forge's answers are the stub's.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempRepo, type TempRepo } from './git-repo.ts';
import { FORGE_TOKEN, startForgeStub, type ForgeStub } from './forge-stub.ts';
import { withInstallation, writeFiles, type InstallationOptions, type TestInstallation } from './installation.ts';

/** The vault's remote URL; Git is told the bare repository is at it. */
export const FORGE_REMOTE = 'https://git.example.net/home/vault.git';

export interface Forge {
  readonly stub: ForgeStub;
  readonly bare: string;
  /** `git` in the forge's repository. */
  readonly remote: (...args: string[]) => string;
}

/** A bare repository and a Gitea stub forge, removed after `run`. */
export async function withForge(run: (forge: Forge) => Promise<void>): Promise<void> {
  const bare = mkdtempSync(join(tmpdir(), 'pav-forge-'));
  const remote = (...args: string[]): string => execFileSync('git', ['-C', bare, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const stub = await startForgeStub('gitea', (branch) => remote('rev-parse', `refs/heads/${branch}`));
  try {
    await run({ stub, bare, remote });
  } finally {
    await stub.server.close();
    rmSync(bare, { recursive: true, force: true });
  }
}

/** Makes the forge `repo`'s origin, and pushes its main there. */
export function connectToForge(repo: TempRepo, forge: Forge): void {
  repo.git('remote', 'add', 'origin', FORGE_REMOTE);
  repo.git('config', `url.${forge.bare}.insteadOf`, FORGE_REMOTE);
  repo.git('push', '--quiet', 'origin', 'main');
}

/** Commits `files` straight onto the forge's main, as a merge in the forge would. */
export function mergeInForge(forge: Forge, files: Record<string, string>): string {
  const clone = createTempRepo();
  try {
    clone.git('fetch', '--quiet', forge.bare, 'main:refs/heads/forge-main');
    clone.git('checkout', '--quiet', 'forge-main');
    writeFiles(clone.path, files);
    const sha = clone.commit('Merge pull request');
    clone.git('push', '--quiet', forge.bare, 'HEAD:refs/heads/main');
    return sha;
  } finally {
    clone.cleanup();
  }
}

/** A test installation whose vault is in forge mode with the forge configured; `forges: false` leaves the forge out of the config. */
export function withForgeInstallation(run: (t: TestInstallation, forge: Forge) => Promise<void>, options: InstallationOptions & { readonly forges?: boolean } = {}): () => Promise<void> {
  const { forges, ...rest } = options;
  return () => withForge(async (forge) => {
    await withInstallation(async (t) => {
      connectToForge(t.repo, forge);
      await run(t, forge);
    }, {
      contract: { review: 'forge', extra: 'merge:\n  - { paths: ["**"], require: [checks, owner] }' },
      ...(forges === false ? {} : { config: `forges:\n  - { host: git.example.net, type: gitea, token: "\${FORGE_TOKEN}", api: "${forge.stub.api}" }` }),
      env: { FORGE_TOKEN },
      ...rest,
    })();
  });
}
