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

/**
 * Merges pull request `number` in the forge as `how` says: a merge commit, a
 * squash into one new commit, or a rebase that copies the commits (as forges
 * do, even onto an unchanged base) and fast-forwards. Returns the new main.
 */
export function mergePullInForge(forge: Forge, number: number, how: 'merge' | 'squash' | 'rebase'): string {
  const pull = forge.stub.model.pulls.find((p) => p.number === number);
  if (pull === undefined) throw new Error(`no pull request #${number}`);
  const clone = createTempRepo();
  try {
    clone.git('fetch', '--quiet', forge.bare, 'main:refs/heads/forge-main', `${pull.head}:refs/heads/proposal`);
    pull.sha = clone.git('rev-parse', 'proposal');
    clone.git('checkout', '--quiet', 'forge-main');
    if (how === 'merge') clone.git('merge', '--quiet', '--no-ff', '-m', `Merge pull request #${number}`, 'proposal');
    if (how === 'squash') {
      clone.git('merge', '--quiet', '--squash', 'proposal');
      clone.git('commit', '--quiet', '-m', `${pull.title} (#${number})`);
    }
    if (how === 'rebase') {
      clone.git('checkout', '--quiet', 'proposal');
      clone.git('rebase', '--quiet', '--force-rebase', 'forge-main');
      clone.git('checkout', '--quiet', 'forge-main');
      clone.git('merge', '--quiet', '--ff-only', 'proposal');
    }
    clone.git('push', '--quiet', forge.bare, 'HEAD:refs/heads/main');
    pull.state = 'merged';
    return clone.git('rev-parse', 'HEAD');
  } finally {
    clone.cleanup();
  }
}

/** A test installation whose vault is in forge mode with the forge configured; `forges: false` leaves the forge out of the config, and any `config` is added to it. */
export function withForgeInstallation(run: (t: TestInstallation, forge: Forge) => Promise<void>, options: InstallationOptions & { readonly forges?: boolean } = {}): () => Promise<void> {
  const { forges, config, ...rest } = options;
  return () => withForge(async (forge) => {
    await withInstallation(async (t) => {
      connectToForge(t.repo, forge);
      await run(t, forge);
    }, {
      contract: { review: 'forge', extra: 'merge:\n  - { paths: ["**"], require: [checks, owner] }' },
      config: [forges === false ? '' : `forges:\n  - { host: git.example.net, type: gitea, token: "\${FORGE_TOKEN}", api: "${forge.stub.api}" }`, config ?? ''].filter((c) => c !== '').join('\n'),
      env: { FORGE_TOKEN },
      ...rest,
    })();
  });
}
