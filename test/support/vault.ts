// A temporary vault for tests: a Git repository with a root contract, a state
// store opened exactly as the package opens it (every module's schema), and
// the vault's registration. Never touches a real vault.

import type { Git } from '../../src/core/git/index.ts';
import { acceptedMain, recordAccepted, type AcceptedMain } from '../../src/core/integrity/index.ts';
import { openStateStore } from '../../src/core/operations/index.ts';
import type { RegisteredVault } from '../../src/core/registry/index.ts';
import type { Store } from '../../src/core/store/index.ts';
import { fakeClock, type FakeClock } from './clock.ts';
import { createTempRepo, gitFor, type TempRepo } from './git-repo.ts';
import { createTempDir } from './temp-dir.ts';

export interface RootContractOptions {
  readonly id?: string;
  readonly owners?: readonly string[];
  readonly actors?: readonly string[];
  readonly review?: 'local' | 'forge';
  /** Extra top-level YAML, such as `merge:` rules. */
  readonly extra?: string;
}

/** A root contract identifying the vault; by default owned by alice, with the actor gardener. */
export function rootContract(options: RootContractOptions = {}): string {
  return [
    '---',
    'vault:',
    `  id: ${options.id ?? 'home'}`,
    '  purpose: { summary: Home things. }',
    '  audience: household',
    `  owners: [${(options.owners ?? ['alice']).join(', ')}]`,
    `  actors: [${(options.actors ?? ['gardener']).join(', ')}]`,
    ...(options.review === undefined ? [] : [`  review: ${options.review}`]),
    ...(options.extra === undefined ? [] : [options.extra.trimEnd()]),
    '---',
    'Root prose.',
    '',
  ].join('\n');
}

/** Trailers that mark a commit as made by the package from an untainted session. */
export const PACKAGE_TRAILERS = '\n\nVault-Trace: 01TRACE\nVault-Actor: gardener';

/** A script or check file with a valid header. */
export function scriptSource(
  name: string,
  body = '',
  options: { readonly net?: 'yes' | 'no'; readonly interpreter?: string; readonly comment?: '#' | '//' } = {},
): string {
  const c = options.comment ?? '#';
  return `#!${options.interpreter ?? '/bin/sh'}\n${c} name: ${name}\n${c} summary: The ${name} script\n${c} net: ${options.net ?? 'yes'}\n${body}\n`;
}

export interface TestVault {
  readonly repo: TempRepo;
  readonly git: Git;
  readonly store: Store;
  readonly vault: RegisteredVault;
  readonly clock: FakeClock;
  /** The first commit, holding the root contract. */
  readonly initial: string;
  /** Records `sha` (default: main's tip) as the accepted main, as `vault init` or an accept would. */
  accept(sha?: string): AcceptedMain;
  /** Commits `files` on actor/gardener (made from main when missing), leaving main checked out; returns the branch tip. */
  propose(files: Record<string, string>, message?: string): string;
}

export function withTestVault(run: (v: TestVault) => Promise<void>, contract: RootContractOptions = {}): () => Promise<void> {
  return async () => {
    const repo = createTempRepo();
    const state = createTempDir('pav-state-');
    const opened = openStateStore({ stateDb: state.file('state.sqlite') });
    if (!opened.ok) throw new Error(`state store: ${JSON.stringify(opened.error)}`);
    const store = opened.value;
    try {
      repo.write('_contract.md', rootContract(contract));
      const initial = repo.commit('Create vault');
      const clock = fakeClock();
      const vault: RegisteredVault = { id: contract.id ?? 'home', path: repo.path, worktrees: state.file('worktrees'), host: false };
      const accept = (sha = repo.git('rev-parse', 'refs/heads/main')): AcceptedMain => {
        const recorded = recordAccepted(store, vault.id, { sha, how: 'init', by: 'alice', at: clock.now() }, acceptedMain(store, vault.id)?.sha ?? null);
        if (!recorded.ok) throw new Error(`accept: ${JSON.stringify(recorded.error)}`);
        return recorded.value;
      };
      const propose = (files: Record<string, string>, message = `Proposal${PACKAGE_TRAILERS}`): string => {
        const exists = repo.git('branch', '--list', 'actor/gardener') !== '';
        repo.git('checkout', '--quiet', ...(exists ? ['actor/gardener'] : ['-b', 'actor/gardener', 'main']));
        for (const [path, content] of Object.entries(files)) repo.write(path, content);
        const head = repo.commit(message);
        repo.git('checkout', '--quiet', 'main');
        return head;
      };
      await run({ repo, git: gitFor(repo), store, vault, clock, initial, accept, propose });
    } finally {
      store.close();
      state.cleanup();
      repo.cleanup();
    }
  };
}
