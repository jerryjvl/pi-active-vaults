// `/vault <command>` (api.md "Commands"): the catalogue's Pi commands, typed
// by the person, so they act as the installation's person and may be owner
// acts; plus `install-cli`, which puts the `vault` launcher on PATH. A command
// line is read exactly as the CLI reads one. What a command says is added to
// the session, shown and kept for the model, and nothing is sent to the model
// by it. An operation awaiting confirmation (adopting) asks the person first,
// when there is a person to ask.

import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { writeLauncher, type Host } from '../core/config/index.ts';
import {
  CATALOGUE, commandRequest, describeCommandLineError, locate, outcomeData, parseLine, splitArguments, usage, type Operation,
} from '../core/operations/index.ts';
import { liveOr, type Holder } from './live.ts';
import { operate } from './operate.ts';

const OUTPUT = 'pav:vault';
const COMMANDS = CATALOGUE.filter((o) => o.surfaces.command);
const nameOf = (operation: Operation): string => operation.command ?? operation.name;

/** The CLI's entry point beside this module: compiled, or the source under test. */
const CLI_PROGRAM = fileURLToPath(new URL(`../cli/main.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url));

function overview(): string {
  return [
    'Usage: /vault <command> [vault] [args]   (/vault <command> --help for its options)',
    '',
    ...COMMANDS.map((o) => `  /vault ${nameOf(o).padEnd(12)} ${o.summary}`),
    `  /vault ${'install-cli'.padEnd(12)} Put the vault launcher on PATH`,
  ].join('\n');
}

function installCli(host: Host): string {
  const written = writeLauncher(host, CLI_PROGRAM);
  if (!written.ok) {
    const { error } = written;
    return error.reason === 'occupied' ? `${error.path} exists and is not a vault launcher; it was left alone.`
      : error.reason === 'unsafe-path' ? `The package's path cannot be written into a launcher safely: ${error.program}`
      : `There is no ${error.variable} to put the launcher under.`;
  }
  const { path, onPath } = written.value;
  return `Wrote ${path}.${onPath ? '' : ` Its directory is not on PATH yet; add it to run "vault" by name.`}`;
}

export function registerCommands(pi: ExtensionAPI, holder: Holder, host: () => Host): void {
  const say = (text: string, details?: unknown): void => {
    pi.sendMessage({ customType: OUTPUT, content: text, display: true, ...(details === undefined ? {} : { details }) });
  };

  async function run(words: readonly string[], ctx: ExtensionCommandContext): Promise<void> {
    const [command = '', ...rest] = words;
    if (command === '' || command === 'help' || command === '--help') return say(overview());
    if (command === 'install-cli') return say(installCli(host()));
    const operation = COMMANDS.find((o) => nameOf(o) === command);
    if (operation === undefined) return say(`"${command}" is not a /vault command.\n\n${overview()}`);
    const line = parseLine(operation, rest, 'command');
    if (line.help) return say(usage(operation, 'command'));
    if (line.problems.length > 0) return say(`${line.problems.join('\n')}\n\n${usage(operation, 'command')}`);
    const found = liveOr(holder);
    if ('problem' in found) return say(found.problem);
    const { live } = found;
    const request = commandRequest(live.context.installation, operation, 'command', line, locate(live.context.installation.vaults, ctx.cwd));
    if (!request.ok) return say(describeCommandLineError(request.error, operation, 'command'));
    const { vaults, params } = request.value;
    let { outcome, notices } = await operate(pi, live, operation, 'command', { vaults, params, cwd: ctx.cwd });
    if (outcome.confirm !== undefined && ctx.hasUI) {
      say(outcome.confirm.shown);
      if (!(await ctx.ui.confirm('Vault', outcome.confirm.question))) return say('Not confirmed; nothing was done.');
      ({ outcome, notices } = await operate(pi, live, operation, 'command', { vaults, params: { ...params, ...outcome.confirm.params }, cwd: ctx.cwd }));
    }
    say([outcome.text, ...notices].filter((t) => t !== '').join('\n\n'), outcomeData(outcome, notices));
  }

  pi.registerCommand('vault', {
    description: 'Vault commands: status, review, accept, contract, jobs, run, trace, doctor, install-cli',
    getArgumentCompletions: (prefix) => {
      const names = [...COMMANDS.map(nameOf), 'install-cli'].filter((n) => n.startsWith(prefix.trim()));
      return names.length === 0 ? null : names.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => run(splitArguments(args), ctx),
  });
}
