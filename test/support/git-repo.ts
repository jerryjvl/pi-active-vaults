// Temporary Git repositories for tests; never touches a real vault.
// Spawns git directly because it exists before src/core/git does; the "only
// core/git spawns git" rule (AGENTS.md §4) governs src/, not test support.
// The environment is isolated from the developer's global and system Git config
// so results do not depend on the machine.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  readonly path: string;
  git(...args: string[]): string;
  write(relativePath: string, content: string): void;
  /** Stage everything and commit; returns the new commit SHA. */
  commit(message: string): string;
  cleanup(): void;
}

export function createTempRepo(options: { branch?: string } = {}): TempRepo {
  const path = mkdtempSync(join(tmpdir(), 'pav-repo-'));
  const emptyConfig = join(path, '.git-test-config');
  writeFileSync(emptyConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_AUTHOR_NAME: 'Alice',
    GIT_AUTHOR_EMAIL: 'alice@example.net',
    GIT_COMMITTER_NAME: 'Alice',
    GIT_COMMITTER_EMAIL: 'alice@example.net',
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: path, env, encoding: 'utf8' }).trim();

  git('init', '--quiet', '--initial-branch', options.branch ?? 'main');
  // The config file lives inside the repo directory; keep it out of commits.
  writeFileSync(join(path, '.git', 'info', 'exclude'), '.git-test-config\n');

  return {
    path,
    git,
    write(relativePath, content) {
      const full = join(path, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commit(message) {
      git('add', '--all');
      git('commit', '--quiet', '--allow-empty', '--message', message);
      return git('rev-parse', 'HEAD');
    },
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
