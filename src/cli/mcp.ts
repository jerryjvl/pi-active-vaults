// `vault mcp --profile <name>` (cli.md, mcp.md): serves one MCP profile over
// standard input/output, for a local client that starts its own server,
// until the client closes its input. Standard output carries only the
// protocol. Like any command it only runs operations, so any number can run
// alongside the daemon; the spawns it requests go to a running daemon.

import { linkDaemon } from '../core/automation/index.ts';
import { createContext, describeError, loadInstallation } from '../core/operations/index.ts';
import { serveMcpStdio } from '../mcp/index.ts';
import type { CliIo } from './run.ts';

const EXIT = { ok: 0, failed: 1, invalid: 2 } as const;
const USAGE = 'Usage: vault mcp --profile <name>';

/** The profile named on the command line, if it is all there is. */
function profileNamed(argv: readonly string[]): string | undefined {
  const rest = argv.slice(1);
  if (rest.length === 1 && rest[0]?.startsWith('--profile=') === true) return rest[0].slice('--profile='.length) || undefined;
  return rest.length === 2 && rest[0] === '--profile' && rest[1] !== '' ? rest[1] : undefined;
}

export async function runMcpCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const name = profileNamed(argv);
  if (name === undefined) {
    io.write('stderr', `vault mcp: name the profile to serve.\n${USAGE}\n`);
    return EXIT.invalid;
  }
  const installation = loadInstallation(io.host);
  if (!installation.ok) {
    io.write('stderr', `vault mcp: the installation cannot be loaded. ${describeError(installation.error)}\n`);
    return EXIT.failed;
  }
  const profile = installation.value.mcp.profiles.find((p) => p.name === name);
  if (profile === undefined) {
    io.write('stderr', `vault mcp: no MCP profile is named "${name}" in the configuration.\n${USAGE}\n`);
    return EXIT.invalid;
  }
  const streams = io.stdio ?? { input: process.stdin, output: process.stdout };
  const link = await linkDaemon(installation.value.paths.socket);
  const made = createContext(installation.value, { ...io.context, ...(link === undefined ? {} : { send: link.send }) });
  if (!made.ok) {
    link?.close();
    io.write('stderr', `vault mcp: the state database cannot be opened (${made.error.reason}).\n`);
    return EXIT.failed;
  }
  const served = serveMcpStdio(made.value, profile, streams);
  try {
    await Promise.race([served.ended, ...(io.until === undefined ? [] : [io.until])]);
  } finally {
    await served.close();
    link?.close();
    made.value.close();
  }
  return EXIT.ok;
}
