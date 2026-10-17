// The `provenance` key of a produced document (concepts.md "Document",
// "Trace"): written by the runtime, never by an agent, naming the run that
// produced the document and the causal path that led to it.
//
// Invariants: writing changes only the `provenance` entry and leaves every
// other byte of the document as it was; reading never guesses — anything but
// a well-formed entry reads as no provenance.

import { parseDocument, updateFrontmatter, type DocumentError } from '../documents/index.ts';
import { isTraceId } from '../ids/index.ts';
import type { Result } from '../result/index.ts';

export const PROVENANCE_KEY = 'provenance';

export interface Provenance {
  readonly trace: string;
  /** The trace IDs of the runs that led to this one, root first. */
  readonly path: readonly string[];
}

/** The document's provenance, or undefined when it has none that is well formed. */
export function provenanceOf(text: string): Provenance | undefined {
  const parsed = parseDocument(text);
  if (!parsed.ok) return undefined;
  const value = parsed.value.frontmatter[PROVENANCE_KEY];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { trace, path } = value as Record<string, unknown>;
  if (typeof trace !== 'string' || !isTraceId(trace)) return undefined;
  if (!Array.isArray(path) || !path.every((id) => typeof id === 'string' && isTraceId(id))) return undefined;
  return { trace, path: [...(path as string[])] };
}

/** The document with its provenance set (replacing any earlier one). */
export function withProvenance(text: string, provenance: Provenance): Result<string, DocumentError> {
  // Provenance comes from the runtime's own trace IDs; anything else is a programming error.
  if (![provenance.trace, ...provenance.path].every(isTraceId)) throw new Error('provenance must name trace IDs');
  return updateFrontmatter(text, { [PROVENANCE_KEY]: { trace: provenance.trace, path: [...provenance.path] } });
}
