// A temporary installation for operation and CLI tests: its own config and
// state directories, one registered vault (a temporary repository with a root
// contract, its main accepted), and an operation context with a fake clock,
// sequential IDs, no network sandbox and injected process liveness. Never
// touches the developer's installation or a real vault.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Host } from '../../src/core/config/index.ts';
import { createGit } from '../../src/core/git/index.ts';
import { createIdSource } from '../../src/core/ids/index.ts';
import { acceptedMain, recordAccepted, type AcceptedMain } from '../../src/core/integrity/index.ts';
import {
  chooseVaults, createContext, loadInstallation, operationNamed, runOperation,
  type Caller, type Installation, type OperationContext, type OperationOutcome, type ParamSurface,
} from '../../src/core/operations/index.ts';
import type { ProcessLiveness } from '../../src/core/process/index.ts';
import type { RegisteredVault } from '../../src/core/registry/index.ts';
import { fakeClock, type FakeClock } from './clock.ts';
import { createTempRepo, type TempRepo } from './git-repo.ts';
import { createTempDir, type TempDir } from './temp-dir.ts';
import { rootContract, type RootContractOptions } from './vault.ts';

export interface InstallationOptions {
  readonly contract?: RootContractOptions;
  /** Extra config YAML, appended. */
  readonly config?: string;
  /** Running processes, by ID, with their start times. */
  readonly running?: Record<number, string>;
  /** Processes that exist but whose start time cannot be told. */
  readonly unknown?: readonly number[];
}

export interface TestInstallation {
  readonly dir: TempDir;
  readonly repo: TempRepo;
  readonly host: Host;
  readonly installation: Installation;
  readonly context: OperationContext;
  readonly vault: RegisteredVault;
  readonly clock: FakeClock;
  accept(sha?: string): AcceptedMain;
  /** Runs an operation as the CLI would, as alice unless `caller` says otherwise. */
  run(name: string, params?: Record<string, unknown>, options?: { vaults?: string[]; caller?: Partial<Caller>; surface?: ParamSurface }): Promise<OperationOutcome>;
  /** Reloads the installation and context, as the next command would. */
  reload(): TestInstallation;
}

function sequentialBytes(): (n: number) => Uint8Array {
  let counter = 0;
  return (n) => {
    counter += 1;
    const bytes = new Uint8Array(n);
    bytes[n - 1] = counter & 0xff;
    bytes[n - 2] = (counter >> 8) & 0xff;
    return bytes;
  };
}

export function hostFor(dir: TempDir, repo: TempRepo): Host {
  return {
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    env: { ...repo.env, PI_ACTIVE_VAULTS_CONFIG: dir.file('config'), PI_ACTIVE_VAULTS_STATE: dir.file('state') },
    home: dir.path,
    user: 'alice',
    hostname: 'homeserver',
  };
}

export function withInstallation(run: (t: TestInstallation) => Promise<void>, options: InstallationOptions = {}): () => Promise<void> {
  return async () => {
    const dir = createTempDir('pav-install-');
    const repo = createTempRepo();
    const clock = fakeClock();
    const randomBytes = sequentialBytes();
    const host = hostFor(dir, repo);
    repo.write('_contract.md', rootContract(options.contract));
    repo.commit('Create vault');
    mkdirSync(dir.file('config'), { recursive: true });
    writeFileSync(dir.file('config', 'config.yaml'), [
      'installation: { name: alice@homeserver, person: alice }',
      `vaults: [{ id: ${options.contract?.id ?? 'home'}, path: ${JSON.stringify(repo.path)} }]`,
      options.config ?? '',
    ].join('\n'));
    const alive: ProcessLiveness = async (pid) =>
      (options.unknown?.includes(pid) === true ? { ok: false, error: { reason: 'cannot-tell', pid } } : { ok: true, value: options.running?.[pid] });
    const contexts: OperationContext[] = [];

    const make = (): TestInstallation => {
      const loaded = loadInstallation(host);
      if (!loaded.ok) throw new Error(`installation: ${JSON.stringify(loaded.error)}`);
      const made = createContext(loaded.value, { git: createGit({ env: repo.env }), clock, ids: createIdSource({ clock, randomBytes }), alive, sandbox: 'none' });
      if (!made.ok) throw new Error(`context: ${JSON.stringify(made.error)}`);
      contexts.push(made.value);
      const context = made.value;
      const [vault] = loaded.value.vaults;
      if (vault === undefined) throw new Error('no vault');
      const t: TestInstallation = {
        dir, repo, host, installation: loaded.value, context, vault, clock,
        accept(sha = repo.git('rev-parse', 'refs/heads/main')) {
          const recorded = recordAccepted(context.state, vault.id, { sha, how: 'init', by: 'alice', at: clock.now() }, acceptedMain(context.state, vault.id)?.sha ?? null);
          if (!recorded.ok) throw new Error(`accept: ${JSON.stringify(recorded.error)}`);
          return recorded.value;
        },
        async run(name, params = {}, runOptions = {}) {
          const operation = operationNamed(name);
          if (operation === undefined) throw new Error(`no operation ${name}`);
          const vaults = chooseVaults(loaded.value, operation, runOptions.vaults ?? [], operation.vault === 'none' ? undefined : vault);
          if (!vaults.ok) throw new Error(`vaults: ${JSON.stringify(vaults.error)}`);
          const caller: Caller = { surface: 'cli', person: 'alice', cwd: repo.path, ...runOptions.caller };
          return runOperation(context, operation, runOptions.surface ?? 'cli', { vaults: vaults.value, params, caller });
        },
        reload: make,
      };
      return t;
    };
    try {
      const t = make();
      t.accept();
      await run(t);
    } finally {
      for (const context of contexts) context.close();
      repo.cleanup();
      dir.cleanup();
    }
  };
}

/** Writes `files` into `root`, making directories. */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}
