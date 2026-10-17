// The structure of a Markdown body: its sections, at its headings, and a
// document's title — read the same way wherever they are needed (search
// chunks a document by section; a judgement names the document it judges).
//
// Lines inside fenced code are content, never headings.

import { parseDocument } from './frontmatter.ts';

export interface MarkdownSection {
  /** The headings above the section, outermost first; empty before the first heading. */
  readonly heading: readonly string[];
  readonly lines: readonly string[];
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The body's sections in order, and the text of its first level-one heading. */
export function markdownSections(body: string): { sections: MarkdownSection[]; firstTitle?: string } {
  const found: { heading: string[]; lines: string[] }[] = [{ heading: [], lines: [] }];
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

function stem(path: string): string {
  return (path.split('/').at(-1) ?? path).replace(/\.md$/i, '');
}

/**
 * A document's title: its frontmatter `title`, else its first level-one
 * heading, else its file name. Frontmatter that cannot be read is ignored:
 * the text is then read as plain Markdown.
 */
export function documentTitle(path: string, text: string): string {
  const parsed = parseDocument(text);
  const given = parsed.ok ? parsed.value.frontmatter['title'] : undefined;
  if (typeof given === 'string' && given.trim() !== '') return given.trim();
  return markdownSections(parsed.ok ? parsed.value.body : text).firstTitle ?? stem(path);
}
