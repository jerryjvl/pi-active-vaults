// Changing frontmatter without disturbing the rest of the file.
//
// A review should show only the real change, so an edit replaces, removes or
// appends the text of one top-level entry and leaves every other byte — quoting
// style, comments, key order, blank lines, line endings, the body — as it was.
// The YAML library supplies each entry's source range; only the changed entry
// is regenerated. A frontmatter written in flow style has no per-entry layout to
// keep, so it is rewritten whole.

import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, stringify, type Document } from 'yaml';
import { err, ok, type Result } from '../result/index.ts';
import {
  detectEol,
  frontmatterData,
  parseYamlMapping,
  splitFrontmatter,
  type DocumentError,
} from './frontmatter.ts';

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | readonly FrontmatterValue[]
  | { readonly [key: string]: FrontmatterValue };

/** Keys to set; `undefined` removes the key. */
export type FrontmatterChanges = Readonly<Record<string, FrontmatterValue | undefined>>;

/** YAML text of one entry, with the file's line ending. Never folds long lines. */
function entryText(key: string, value: FrontmatterValue, eol: string): string {
  return stringify(new Map([[key, value]]), { lineWidth: 0 }).replace(/\n/g, eol);
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  if (index > 0 && text[index - 1] === '\n') return index;
  const newline = text.indexOf('\n', index);
  return newline === -1 ? text.length : newline + 1;
}

function applyOne(yaml: string, key: string, value: FrontmatterValue | undefined, eol: string, firstLine: number): Result<string, DocumentError> {
  const parsed = parseYamlMapping(yaml, firstLine);
  if (!parsed.ok) return parsed;
  const document: Document = parsed.value;
  const map = document.contents;

  if (map === null) {
    if (value === undefined) return ok(yaml);
    return ok((yaml === '' || yaml.endsWith('\n') ? yaml : yaml + eol) + entryText(key, value, eol));
  }
  if (!isMap(map)) return err({ reason: 'frontmatter-not-a-mapping' });

  if (map.flow === true) {
    if (value === undefined) document.delete(key);
    else document.set(key, value);
    return ok(document.toString({ lineWidth: 0 }).replace(/\n/g, eol));
  }

  const pair = map.items.find((item) => isScalar(item.key) && String(item.key.value) === key);
  if (pair === undefined) {
    if (value === undefined) return ok(yaml);
    return ok((yaml.endsWith('\n') ? yaml : yaml + eol) + entryText(key, value, eol));
  }

  const keyRange = (pair.key as { range?: [number, number, number] | null }).range;
  const valueRange = (pair.value as { range?: [number, number, number] | null } | null)?.range;
  if (!keyRange) return err({ reason: 'invalid-frontmatter', problems: ['MISSING_SOURCE_RANGE'] });
  const start = keyRange[0];
  const end = valueRange?.[1] ?? keyRange[1];

  if (value === undefined) {
    // The entry's own line(s), including a trailing comment on its last line.
    return ok(yaml.slice(0, lineStart(yaml, start)) + yaml.slice(lineEnd(yaml, end)));
  }
  const data = frontmatterData(document);
  if (!data.ok) return data;
  if (isDeepStrictEqual(data.value[key], value)) return ok(yaml);

  // Text that followed the old value on its line (a trailing comment) stays put.
  const replacement = entryText(key, value, eol);
  const endsLine = yaml.slice(start, end).endsWith('\n');
  return ok(yaml.slice(0, start) + (endsLine ? replacement : replacement.slice(0, -eol.length)) + yaml.slice(end));
}

function validKey(key: string): boolean {
  return key !== '' && !/[\n\r\0]/.test(key);
}

/**
 * Applies `changes` to a document's frontmatter, creating the frontmatter if
 * there is none and a key is being set. Everything not changed is preserved
 * byte for byte, including the body.
 */
export function updateFrontmatter(text: string, changes: FrontmatterChanges): Result<string, DocumentError> {
  const entries = Object.entries(changes);
  if (!entries.every(([key]) => validKey(key))) return err({ reason: 'invalid-key' });

  const parts = splitFrontmatter(text);
  if (!parts.ok) return parts;

  if (parts.value === null) {
    const eol = detectEol(text);
    let yaml = '';
    for (const [key, value] of entries) {
      const applied = applyOne(yaml, key, value, eol, 2);
      if (!applied.ok) return applied;
      yaml = applied.value;
    }
    if (yaml === '') return ok(text);
    const bom = text.startsWith('﻿') ? '﻿' : '';
    return ok(`${bom}---${eol}${yaml}---${eol}${text.slice(bom.length)}`);
  }

  const { open, close, body, eol } = parts.value;
  let yaml = parts.value.yaml;
  for (const [key, value] of entries) {
    const applied = applyOne(yaml, key, value, eol, 2);
    if (!applied.ok) return applied;
    yaml = applied.value;
  }
  return ok(open + yaml + close + body);
}
