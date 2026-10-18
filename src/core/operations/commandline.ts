// Reading a command line into an operation's parameters, from the
// operation's own specs — the same for the `vault` CLI and Pi's `/vault`
// commands, each offering its own surface's parameters: positional parameters
// in order (a list takes the rest; a passthrough list takes options too, so a
// script's own pass through), `--name value`, `--name=value`, `-x value`,
// `--flag` for booleans, and a repeated flag for a list. Nothing about any
// particular command is known here.
//
// The global flags every command takes: `--json`, `--vault <id>` (repeatable),
// `--help`.
//
// Pi hands a command its arguments as one string; `splitArguments` groups
// words with quotes and backslashes as a shell would, and expands nothing —
// no variables, globs or substitutions — because nothing here runs a shell.

import type { RegisteredVault } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import { chooseVaults, isRequired, paramsOn, placeVaultPaths, type VaultChoiceError } from './catalogue.ts';
import type { Installation } from './installation.ts';
import type { Location } from './locate.ts';
import type { Operation, ParamSpec, ParamSurface } from './types.ts';

export interface ParsedLine {
  readonly params: Record<string, unknown>;
  /** The positional arguments, in order, before they are given to parameters. */
  readonly positionals: readonly string[];
  readonly vaults: readonly string[];
  readonly json: boolean;
  readonly help: boolean;
  readonly problems: readonly string[];
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function flagSpec(specs: readonly ParamSpec[], token: string): ParamSpec | undefined {
  if (token.startsWith('--')) return specs.find((p) => p.positional !== true && kebab(p.name) === token.slice(2));
  return specs.find((p) => p.short !== undefined && `-${p.short}` === token);
}

function setValue(params: Record<string, unknown>, spec: ParamSpec, value: string | true, problems: string[]): void {
  switch (spec.kind) {
    case 'boolean':
      params[spec.name] = value === true || value === 'true';
      return;
    case 'integer': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
      params[spec.name] = n;
      return;
    }
    case 'strings':
      params[spec.name] = [...((params[spec.name] as string[] | undefined) ?? []), String(value)];
      return;
    case 'string':
      if (params[spec.name] !== undefined) problems.push(`--${kebab(spec.name)} is given twice`);
      params[spec.name] = String(value);
  }
}

/** Splits the arguments after the command into flags and positionals. */
export function parseLine(operation: Operation, argv: readonly string[], surface: ParamSurface = 'cli'): ParsedLine {
  const specs = paramsOn(operation, surface);
  const params: Record<string, unknown> = {};
  const positionals: string[] = [];
  const vaults: string[] = [];
  const problems: string[] = [];
  let json = false;
  let help = false;
  const rest = specs.find((p) => p.positional === true && p.kind === 'strings');
  const singles = specs.filter((p) => p.positional === true && p.kind !== 'strings').length;
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    // Once a passthrough list is reached, everything belongs to it.
    const filling = rest?.passthrough === true && positionals.length >= Math.max(1, singles);
    if (literal || filling || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    const [name, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    if (name === '--json') json = true;
    else if (name === '--help' || name === '-h') help = true;
    else if (name === '--vault') {
      const value = inline ?? argv[++i];
      if (value === undefined) problems.push('--vault needs a vault id');
      else vaults.push(value);
    } else {
      const spec = flagSpec(specs, name);
      if (spec === undefined) {
        problems.push(`${name} is not an option of "${operation.command ?? operation.name}"`);
      } else if (spec.kind === 'boolean') {
        setValue(params, spec, inline ?? true, problems);
      } else {
        const value = inline ?? argv[++i];
        if (value === undefined) problems.push(`${name} needs a value`);
        else setValue(params, spec, value, problems);
      }
    }
  }
  return { params, positionals, vaults, json, help, problems };
}

/** Gives the positional arguments to the operation's positional parameters, in order; returns what is left over. */
export function assignPositionals(operation: Operation, params: Record<string, unknown>, positionals: readonly string[], surface: ParamSurface = 'cli'): string[] {
  const specs = paramsOn(operation, surface).filter((p) => p.positional === true);
  const left = [...positionals];
  for (const spec of specs) {
    if (left.length === 0) break;
    if (spec.kind === 'strings') {
      params[spec.name] = [...((params[spec.name] as string[] | undefined) ?? []), ...left.splice(0)];
    } else if (params[spec.name] === undefined) {
      params[spec.name] = left.shift();
    }
  }
  return left;
}

/** How a command is used, from its specs. */
export function usage(operation: Operation, surface: ParamSurface = 'cli'): string {
  const specs = paramsOn(operation, surface);
  const positional = specs.filter((p) => p.positional === true)
    .map((p) => (p.kind === 'strings' ? `[${p.name}...]` : isRequired(p, surface) ? `<${p.name}>` : `[${p.name}]`));
  const vault = operation.vault === 'none' ? [] : ['[vault]'];
  const flags = specs.filter((p) => p.positional !== true).map((p) => {
    const value = p.kind === 'boolean' ? '' : ` <${p.name}>`;
    const text = `${p.short === undefined ? '' : `-${p.short}, `}--${kebab(p.name)}${value}`;
    return `  ${text.padEnd(28)} ${p.description}${p.stdin === true ? ' (read from standard input when not given)' : ''}${p.file === true ? ' (a file)' : ''}`;
  });
  return [`${surface === 'command' ? '/vault' : 'vault'} ${operation.command ?? operation.name} ${[...vault, ...positional].join(' ')}`.trimEnd(), `  ${operation.summary}`, ...(flags.length === 0 ? [] : ['', ...flags])].join('\n');
}

/** The words of a command line: quotes group, a backslash escapes the next character, and nothing is expanded. */
export function splitArguments(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i] as string;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < line.length) {
      word = (word ?? '') + (line[++i] as string);
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

export type CommandLineError = { readonly reason: 'extra-arguments'; readonly extra: readonly string[] } | VaultChoiceError;

/**
 * The vaults and parameters a command line asks for: a first argument naming
 * a registered vault is the vault, when what remains still fills the command
 * (`vault <command> [vault] …`); the rest fill the positional parameters in
 * order; vault paths name their vaults; and the vaults are chosen as for every
 * surface — those named, else the one the caller is in (`here`).
 */
export function commandRequest(
  installation: Pick<Installation, 'vaults'>, operation: Operation, surface: ParamSurface, line: ParsedLine, here?: Location,
): Result<{ vaults: RegisteredVault[]; params: Record<string, unknown> }, CommandLineError> {
  const params = { ...line.params };
  const named = [...line.vaults];
  const positionals = [...line.positionals];
  const required = paramsOn(operation, surface).filter((p) => p.positional === true && isRequired(p, surface)).length;
  if (operation.vault !== 'none' && positionals.length > required && installation.vaults.some((v) => v.id === positionals[0])) {
    named.push(positionals.shift() ?? '');
  }
  const extra = assignPositionals(operation, params, positionals, surface);
  if (extra.length > 0) return err({ reason: 'extra-arguments', extra });
  const placed = placeVaultPaths(installation, operation, surface, params, named, here);
  const chosen = chooseVaults(installation, operation, placed.named, here?.vault);
  return chosen.ok ? ok({ vaults: chosen.value, params: placed.params }) : chosen;
}

/** Why a request does not fit, for whoever made it: the person who typed a command line, or a model. */
export function describeCommandLineError(error: CommandLineError, operation: Operation, surface: ParamSurface): string {
  switch (error.reason) {
    case 'extra-arguments':
      return `Too many arguments: ${error.extra.join(' ')}\n\n${usage(operation, surface)}`;
    case 'unknown-vault':
      return `"${error.vault}" is not a registered vault.`;
    case 'which-vault':
      return surface === 'tool' || surface === 'mcp'
        ? 'Which vault? Name it in a path, as <vault-id>:<path>.'
        : `Which vault? Name it (${surface === 'command' ? '/vault' : 'vault'} ${operation.command ?? operation.name} <vault> …, or --vault), or run this inside one.`;
  }
}
