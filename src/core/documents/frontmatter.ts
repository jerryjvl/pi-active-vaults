// Splitting a Markdown file into frontmatter and body, and reading the
// frontmatter as plain data.
//
// Invariants: the body is returned exactly as written; frontmatter that cannot
// be read unambiguously (unterminated, invalid YAML, not a mapping, a repeated
// key, an alias-expansion bomb) is an error value, never a partial result;
// YAML 1.2 core types only, so dates and words like `yes` stay strings and no
// tag can construct anything but data. Errors carry positions and codes, never
// content, because frontmatter may hold something a user pasted by mistake.

import { isMap, parseDocument as parseYaml, type Document } from 'yaml';
import { err, ok, type Result } from '../result/index.ts';

export type DocumentError =
  | { readonly reason: 'unterminated-frontmatter' }
  | { readonly reason: 'invalid-frontmatter'; readonly problems: readonly string[] }
  | { readonly reason: 'frontmatter-not-a-mapping' }
  | { readonly reason: 'invalid-key' };

export interface ParsedDocument {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly hasFrontmatter: boolean;
}

/** The pieces of a file with frontmatter; joining them reproduces the file byte for byte. */
export interface FrontmatterParts {
  /** Byte-order mark and opening delimiter line. */
  readonly open: string;
  /** The YAML between the delimiters, ending with a line break unless empty. */
  readonly yaml: string;
  /** The closing delimiter line. */
  readonly close: string;
  readonly body: string;
  /** The file's line ending, applied to anything written. */
  readonly eol: '\n' | '\r\n';
}

const BOM = '﻿';
const OPENING = /^---[ \t]*(\r?\n)/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;
const MAX_ALIAS_COUNT = 100;

export function detectEol(text: string): '\n' | '\r\n' {
  const newline = text.indexOf('\n');
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}

/** Returns null when the file has no frontmatter. */
export function splitFrontmatter(text: string): Result<FrontmatterParts | null, DocumentError> {
  const bom = text.startsWith(BOM) ? BOM : '';
  const rest = text.slice(bom.length);
  const opening = OPENING.exec(rest);
  if (opening === null) return ok(null);
  const open = bom + opening[0];
  let position = opening[0].length;
  while (position < rest.length) {
    const newline = rest.indexOf('\n', position);
    const lineEnd = newline === -1 ? rest.length : newline + 1;
    const line = rest.slice(position, lineEnd).replace(/\r?\n$/, '');
    if (CLOSING.test(line)) {
      return ok({
        open,
        yaml: rest.slice(opening[0].length, position),
        close: rest.slice(position, lineEnd),
        body: rest.slice(lineEnd),
        eol: opening[1] === '\r\n' ? '\r\n' : '\n',
      });
    }
    position = lineEnd;
  }
  return err({ reason: 'unterminated-frontmatter' });
}

/** Parses the YAML between the delimiters; `firstLine` is its line number in the file, for messages. */
export function parseYamlMapping(yaml: string, firstLine: number): Result<Document, DocumentError> {
  const document = parseYaml(yaml, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return err({
      reason: 'invalid-frontmatter',
      problems: document.errors.map((e) => `${e.code} at line ${(e.linePos?.[0].line ?? 1) + firstLine - 1}`),
    });
  }
  // Empty or comment-only frontmatter has no contents at all: an empty mapping.
  if (document.contents !== null && !isMap(document.contents)) return err({ reason: 'frontmatter-not-a-mapping' });
  return ok(document);
}

export function frontmatterData(document: Document): Result<Record<string, unknown>, DocumentError> {
  try {
    return ok((document.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) ?? {}) as Record<string, unknown>);
  } catch {
    // Excessive alias expansion; the library's message is not needed.
    return err({ reason: 'invalid-frontmatter', problems: ['ALIAS_EXPANSION_LIMIT'] });
  }
}

export function parseDocument(text: string): Result<ParsedDocument, DocumentError> {
  const parts = splitFrontmatter(text);
  if (!parts.ok) return parts;
  if (parts.value === null) return ok({ frontmatter: {}, body: text, hasFrontmatter: false });
  const document = parseYamlMapping(parts.value.yaml, 2);
  if (!document.ok) return document;
  const data = frontmatterData(document.value);
  return data.ok ? ok({ frontmatter: data.value, body: parts.value.body, hasFrontmatter: true }) : data;
}
