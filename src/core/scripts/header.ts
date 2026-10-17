// Script headers (concepts.md "Script"): the `#!` line, then a block of
// `key: value` comment lines (`#` or `//`). The block ends at the first line
// that is not such an entry, so prose comments can follow after a blank
// comment line. Inside the block only the documented keys are allowed: a
// misspelt `net: no` must be an error, not a script quietly given network.

import { posix } from 'node:path';
import { DataReader, type Issue, type Result } from '../result/index.ts';

export interface ScriptHeader {
  readonly name: string;
  readonly summary: string;
  readonly args?: string;
  readonly output?: string;
  /** False when the script declares `net: no`. */
  readonly net: boolean;
  /** The `#!` line, split into the interpreter and its arguments. */
  readonly interpreter: readonly string[];
}

const HEADER_KEYS = ['name', 'summary', 'args', 'output', 'net'] as const;
type HeaderKey = (typeof HEADER_KEYS)[number];
const ENTRY = /^\s*(?:#|\/\/)\s*([A-Za-z][A-Za-z0-9-]*):\s*(.*?)\s*$/;

/** A script's name: its file name without the extension. */
export function scriptNameOf(path: string): string {
  const file = posix.basename(path);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/** Parses the header of the script at `path` (used for its name and in issue paths). */
export function parseScriptHeader(text: string, path: string): Result<ScriptHeader, Issue[]> {
  const r = new DataReader();
  const where = (key: string): string => `${path}:${key}`;
  const lines = text.split(/\r?\n/);
  const shebang = lines[0]?.startsWith('#!') === true ? lines[0].slice(2).trim().split(/\s+/).filter((t) => t !== '') : [];

  const entries = new Map<HeaderKey, string>();
  for (const line of lines.slice(lines[0]?.startsWith('#!') === true ? 1 : 0)) {
    const entry = ENTRY.exec(line);
    if (entry === null) break;
    const key = entry[1] as HeaderKey;
    if (!HEADER_KEYS.includes(key)) r.add(where(entry[1] ?? ''), 'unknown header key');
    else if (entries.has(key)) r.add(where(key), 'is given twice');
    else entries.set(key, entry[2] ?? '');
  }

  const expected = scriptNameOf(path);
  const name = entries.get('name');
  if (name === undefined || name === '') r.add(where('name'), 'is required');
  else if (name !== expected) r.add(where('name'), `must be the file name without its extension (${expected})`);
  const summary = entries.get('summary');
  if (summary === undefined || summary === '') r.add(where('summary'), 'is required');
  const net = entries.has('net') ? r.oneOf(entries.get('net'), where('net'), ['yes', 'no'] as const) : 'yes';
  if (shebang.length === 0) r.add(where('interpreter'), 'needs a #! line naming its interpreter');

  const args = entries.get('args');
  const output = entries.get('output');
  return r.result({
    name: name ?? '',
    summary: summary ?? '',
    ...(args === undefined ? {} : { args }),
    ...(output === undefined ? {} : { output }),
    net: net !== 'no',
    interpreter: shebang,
  });
}
