// Splitting a document into chunks for the index (core.md "Search"): one
// chunk per section, at its headings, each with a header naming the vault, the
// document's title and the section's heading path — so a chunk read alone, by
// a person, a keyword match or an embedding model, says where it is from.
//
// Sections and the title are read by `documents`. A long section is split at
// paragraphs, and an overlong paragraph is cut, so no chunk exceeds
// MAX_CHUNK_CHARS. A document whose frontmatter cannot be read is indexed as
// plain text: search reads content, it does not enforce frontmatter.

import { documentTitle, markdownSections, parseDocument } from '../documents/index.ts';

export interface Chunk {
  /** The headings above the section, outermost first. */
  readonly heading: readonly string[];
  readonly header: string;
  readonly body: string;
}

const MAX_CHUNK_CHARS = 1500;

/** Pieces of at most MAX_CHUNK_CHARS: whole paragraphs where they fit, cut where one does not. */
function pieces(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter((p) => p !== '')) {
    if (current !== '' && current.length + 2 + paragraph.length <= MAX_CHUNK_CHARS) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }
    if (current !== '') out.push(current);
    current = paragraph;
    while (current.length > MAX_CHUNK_CHARS) {
      out.push(current.slice(0, MAX_CHUNK_CHARS));
      current = current.slice(MAX_CHUNK_CHARS);
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** The document's title and its chunks. */
export function chunkDocument(vault: string, path: string, text: string): { title: string; chunks: Chunk[] } {
  const parsed = parseDocument(text);
  const title = documentTitle(path, text);
  const chunks = markdownSections(parsed.ok ? parsed.value.body : text).sections.flatMap(({ heading, lines }) => {
    const header = [vault, title, heading.join(' › ')].filter((part) => part !== '').join(' · ');
    return pieces(lines.join('\n')).map((piece) => ({ heading, header, body: piece }));
  });
  return { title, chunks };
}

/** What an embedding model is given for a chunk: its header, then its text. */
export function embeddingText(chunk: { readonly header: string; readonly body: string }): string {
  return `${chunk.header}\n\n${chunk.body}`;
}
