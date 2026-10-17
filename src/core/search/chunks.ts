// Splitting a document into chunks for the index (core.md "Search"): one
// chunk per section, at its headings, each with a header naming the vault, the
// document's title and the section's heading path — so a chunk read alone, by
// a person, a keyword match or an embedding model, says where it is from.
//
// Lines inside fenced code are content, never headings. A long section is
// split at paragraphs, and an overlong paragraph is cut, so no chunk exceeds
// MAX_CHUNK_CHARS. A document whose frontmatter cannot be read is indexed as
// plain text: search reads content, it does not enforce frontmatter.

import { parseDocument } from '../documents/index.ts';

export interface Chunk {
  /** The headings above the section, outermost first. */
  readonly heading: readonly string[];
  readonly header: string;
  readonly body: string;
}

export const MAX_CHUNK_CHARS = 1500;

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface Section {
  readonly heading: string[];
  readonly lines: string[];
}

function sections(body: string): { sections: Section[]; firstTitle?: string } {
  const found: Section[] = [{ heading: [], lines: [] }];
  const stack: { level: number; text: string }[] = [];
  let fence: string | undefined;
  let firstTitle: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fenceMark !== undefined) {
      if (fence === undefined) fence = fenceMark;
      else if (fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined;
    }
    const heading = fence === undefined && fenceMark === undefined ? HEADING.exec(line) : null;
    if (heading === null) {
      found[found.length - 1]?.lines.push(line);
      continue;
    }
    const level = heading[1]?.length ?? 1;
    const text = (heading[2] ?? '').trim();
    if (level === 1 && firstTitle === undefined && text !== '') firstTitle = text;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, text });
    found.push({ heading: stack.map((h) => h.text), lines: [] });
  }
  return { sections: found, ...(firstTitle === undefined ? {} : { firstTitle }) };
}

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

function stem(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.md$/i, '');
}

/** The document's title and its chunks. */
export function chunkDocument(vault: string, path: string, text: string): { title: string; chunks: Chunk[] } {
  const parsed = parseDocument(text);
  const body = parsed.ok ? parsed.value.body : text;
  const given = parsed.ok ? parsed.value.frontmatter['title'] : undefined;
  const { sections: found, firstTitle } = sections(body);
  const title = typeof given === 'string' && given.trim() !== '' ? given.trim() : firstTitle ?? stem(path);
  const chunks = found.flatMap(({ heading, lines }) => {
    const header = [vault, title, heading.join(' › ')].filter((part) => part !== '').join(' · ');
    return pieces(lines.join('\n')).map((piece) => ({ heading, header, body: piece }));
  });
  return { title, chunks };
}

/** What an embedding model is given for a chunk: its header, then its text. */
export function embeddingText(chunk: { readonly header: string; readonly body: string }): string {
  return `${chunk.header}\n\n${chunk.body}`;
}
