// The `vault` CLI as a person runs it, in tests: arguments in, exit status and
// both output streams out, on a test installation's machine with its clock
// and Git environment. Each call loads the installation afresh, as each
// command does.

import { createServer } from 'node:http';
import { runCli, type CliIo } from '../../src/cli/run.ts';
import { createGit } from '../../src/core/git/index.ts';
import type { TestInstallation } from './installation.ts';

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  /** Where the command runs; the vault's checkout by default. */
  readonly cwd?: string;
  readonly stdin?: string;
  /** The answer at a terminal's confirmation prompt; no terminal when absent. */
  readonly confirm?: boolean;
  /** Streams for a command that serves over standard input/output. */
  readonly stdio?: CliIo['stdio'];
  /** Anything else of the command's surroundings to replace: its machine, a service manager, the daemon's options. */
  readonly io?: Partial<CliIo>;
}

export function cliFor(t: TestInstallation, options: CliOptions = {}): (...argv: string[]) => Promise<Ran> {
  return async (...argv) => {
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      write: (stream, text) => {
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      },
      readStdin: async () => options.stdin,
      ...(options.confirm === undefined ? {} : { confirm: async () => options.confirm ?? false }),
      ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
      cwd: options.cwd ?? t.repo.path,
      host: t.host,
      context: { git: createGit({ env: t.repo.env }), clock: t.clock, sandbox: 'none', alive: t.context.alive },
      ...options.io,
    };
    const code = await runCli(argv, io);
    return { code, stdout, stderr };
  };
}

/** A TCP port nothing listens on just now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === 'object' && address !== null ? address.port : 0;
}
