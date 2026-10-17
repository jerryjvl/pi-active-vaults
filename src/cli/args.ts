// Reading a command line into an operation's parameters, from the
// operation's own specs: positional parameters in order (a list takes the
// rest; a passthrough list takes options too, so a script's own pass
// through), `--name value`, `--name=value`, `-x value`, `--flag` for
// booleans, and a repeated flag for a list. Nothing about any particular
// command is known here.
//
// The global flags every command takes: `--json`, `--vault <id>` (repeatable),
// `--help`.

import type { Operation, ParamSpec } from '../core/operations/index.ts';
import { paramsOn } from '../core/operations/index.ts';

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
export function parseLine(operation: Operation, argv: readonly string[]): ParsedLine {
  const specs = paramsOn(operation, 'cli');
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
export function assignPositionals(operation: Operation, params: Record<string, unknown>, positionals: readonly string[]): string[] {
  const specs = paramsOn(operation, 'cli').filter((p) => p.positional === true);
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
export function usage(operation: Operation): string {
  const specs = paramsOn(operation, 'cli');
  const positional = specs.filter((p) => p.positional === true)
    .map((p) => (p.kind === 'strings' ? `[${p.name}...]` : p.required === true ? `<${p.name}>` : `[${p.name}]`));
  const vault = operation.vault === 'none' ? [] : ['[vault]'];
  const flags = specs.filter((p) => p.positional !== true).map((p) => {
    const value = p.kind === 'boolean' ? '' : ` <${p.name}>`;
    const text = `${p.short === undefined ? '' : `-${p.short}, `}--${kebab(p.name)}${value}`;
    return `  ${text.padEnd(28)} ${p.description}${p.stdin === true ? ' (read from standard input when not given)' : ''}${p.file === true ? ' (a file)' : ''}`;
  });
  return [`vault ${operation.command ?? operation.name} ${[...vault, ...positional].join(' ')}`.trimEnd(), `  ${operation.summary}`, ...(flags.length === 0 ? [] : ['', ...flags])].join('\n');
}
