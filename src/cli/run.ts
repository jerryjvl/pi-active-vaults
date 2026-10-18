// The `vault` command (cli.md): every operation the catalogue offers on the
// CLI, generated from it — this file knows no command by name except
// `daemon …` (daemon.ts) and `mcp` (mcp.ts), which run as processes. It parses,
// asks the core, and presents:
//
//  - every command first reports each vault with an unaccepted change, on
//    standard error;
//  - `vault <command> [vault] [args]`: the vault may be named first, with
//    `--vault`, or in a path as `<vault-id>:<path>`; otherwise it is the one
//    the current directory is in (its checkout, or an actor's worktree, which
//    also makes that actor the one commits are made as);
//  - output is the operation's text, or with `--json` its data; the exit
//    status is 0 for success, 1 for a failure, 2 for a usage error and 3 for
//    a refusal by policy or a guard;
//  - adopting asks for confirmation when there is someone to ask; otherwise
//    it shows the delta and how to confirm it.

import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { isAbsolute, resolve } from 'node:path';
import type { Host, ServiceProgram } from '../core/config/index.ts';
import {
  CATALOGUE, commandRequest, createContext, describeCommandLineError, describeError, loadInstallation, locate, outcomeData, paramsOn, parseLine, runOperation, unacceptedNotices, usage,
  type ContextOptions, type Operation, type OperationOutcome,
} from '../core/operations/index.ts';
import { linkDaemon } from '../core/automation/index.ts';
import type { DaemonOptions } from '../daemon/daemon.ts';
import { runDaemonCommand } from './daemon.ts';
import { runMcpCommand } from './mcp.ts';

export interface CliIo {
  write(stream: 'stdout' | 'stderr', text: string): void;
  /** Standard input's text, or undefined when it is a terminal. */
  readStdin(): Promise<string | undefined>;
  /** Asks the person at the terminal; absent when there is none. */
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly cwd: string;
  readonly host: Host;
  /** Services to use instead of the system's (tests). */
  readonly context?: ContextOptions;
  /** `vault daemon run` stops when this resolves (the process's signals); it runs until then. */
  readonly until?: Promise<void>;
  /** How `vault daemon` runs a service manager's command (tests). */
  readonly runProgram?: (program: ServiceProgram) => Promise<number>;
  /** The streams `vault mcp` speaks over (default: the process's own standard input and output). */
  readonly stdio?: { readonly input: Readable; readonly output: Writable };
  /** What `vault daemon run` is started with besides the machine (tests). */
  readonly daemon?: Pick<DaemonOptions, 'pid' | 'pi' | 'env' | 'timeZone'>;
}

const EXIT = { ok: 0, failed: 1, invalid: 2, refused: 3 } as const;

const onCli = CATALOGUE.filter((o) => o.surfaces.cli);

function overview(): string {
  const lines = onCli.map((o) => `  ${(o.command ?? o.name).padEnd(16)} ${o.summary}`);
  return [
    'Usage: vault <command> [vault] [args]   (vault <command> --help for its options)',
    '',
    ...lines,
    `  ${'daemon …'.padEnd(16)} Install, control or run the daemon`,
    `  ${'mcp'.padEnd(16)} Serve an MCP profile over standard input/output`,
    '',
    'Every command takes --json (machine-readable output) and --vault <id>.',
  ].join('\n');
}

function findOperation(argv: readonly string[]): { operation: Operation; rest: string[] } | undefined {
  const [first = '', second = ''] = argv;
  const twoWords = onCli.find((o) => o.command === `${first} ${second}`);
  if (twoWords !== undefined) return { operation: twoWords, rest: argv.slice(2) };
  const one = onCli.find((o) => o.command === undefined && o.name === first);
  return one === undefined ? undefined : { operation: one, rest: argv.slice(1) };
}

function print(io: CliIo, outcome: OperationOutcome, json: boolean, notices: readonly string[]): number {
  if (json) io.write('stdout', `${JSON.stringify(outcomeData(outcome, notices))}\n`);
  else if (outcome.text !== '') io.write(outcome.status === 'ok' ? 'stdout' : 'stderr', outcome.text.endsWith('\n') ? outcome.text : `${outcome.text}\n`);
  return EXIT[outcome.status];
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.write('stdout', `${overview()}\n`);
    return EXIT.ok;
  }
  if (command === 'daemon') return runDaemonCommand(argv, io);
  if (command === 'mcp') return runMcpCommand(argv, io);
  const found = findOperation(argv);
  if (found === undefined) {
    io.write('stderr', `vault: "${command}" is not a command.\n\n${overview()}\n`);
    return EXIT.invalid;
  }
  const { operation } = found;
  const line = parseLine(operation, found.rest);
  if (line.help) {
    io.write('stdout', `${usage(operation)}\n`);
    return EXIT.ok;
  }
  if (line.problems.length > 0) {
    io.write('stderr', `${line.problems.join('\n')}\n\n${usage(operation)}\n`);
    return EXIT.invalid;
  }

  const installation = loadInstallation(io.host);
  if (!installation.ok) {
    io.write('stderr', `vault: the installation cannot be loaded. ${describeError(installation.error)}\n`);
    return EXIT.failed;
  }
  // A daemon that runs takes the spawns a command requests at once; without one they are queued for it.
  const link = await linkDaemon(installation.value.paths.socket);
  const made = createContext(installation.value, { ...io.context, ...(link === undefined ? {} : { send: link.send }) });
  if (!made.ok) {
    link?.close();
    io.write('stderr', `vault: the state database cannot be opened (${made.error.reason}).\n`);
    return EXIT.failed;
  }
  const context = made.value;
  try {
    const { vaults } = installation.value;
    const notices = (await unacceptedNotices(context, vaults)).map((n) => n.notice);
    for (const notice of notices) io.write('stderr', `${notice}\n`);

    const here = locate(vaults, io.cwd);
    const request = commandRequest(installation.value, operation, 'cli', line, here);
    if (!request.ok) {
      io.write('stderr', `${describeCommandLineError(request.error, operation, 'cli')}\n`);
      return EXIT.invalid;
    }
    const { params } = request.value;
    for (const spec of paramsOn(operation, 'cli')) {
      const value = params[spec.name];
      if (spec.file === true && typeof value === 'string') {
        try {
          params[spec.name] = readFileSync(isAbsolute(value) ? value : resolve(io.cwd, value), 'utf8');
        } catch {
          io.write('stderr', `--${spec.name}: ${value} cannot be read.\n`);
          return EXIT.invalid;
        }
      }
      if (spec.stdin === true && value === undefined) {
        const input = await io.readStdin();
        if (input !== undefined) params[spec.name] = input;
      }
    }
    const { person } = installation.value.config;
    const caller = { surface: 'cli' as const, cwd: io.cwd, ...(person === undefined ? {} : { person }), ...(here?.actor === undefined ? {} : { actor: here.actor }) };
    let outcome = await runOperation(context, operation, 'cli', { vaults: request.value.vaults, params, caller });

    // An operation awaiting confirmation (adopting) shows what it would do; the person confirms what they saw.
    const { confirm } = outcome;
    if (confirm !== undefined && io.confirm !== undefined) {
      io.write('stderr', `${confirm.shown}\n\n`);
      if (!(await io.confirm(confirm.question))) {
        io.write('stderr', 'Not confirmed; nothing was done.\n');
        return EXIT.refused;
      }
      outcome = await runOperation(context, operation, 'cli', { vaults: request.value.vaults, caller, params: { ...params, ...confirm.params } });
    }
    return print(io, outcome, line.json, notices);
  } finally {
    link?.close();
    context.close();
  }
}
