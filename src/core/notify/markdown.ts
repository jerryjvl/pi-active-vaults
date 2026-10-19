// A Markdown document as an email (notifications.md "Use"): its front matter
// dropped, the rest as the plain-text part, and an HTML part rendered from a
// small subset — headings, paragraphs, lists, quotes, code, rules, bold,
// italics, inline code and links.
//
// Invariants:
//  - every character of the source is escaped before any markup is added, so
//    HTML in a document (which may carry text from web pages) is shown, never
//    rendered;
//  - a link becomes an anchor only to an http(s) URL; any other link is left
//    as its text;
//  - nothing is fetched or embedded: no images, no styles from the document.

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

const escape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** One line's inline markup, on text that is escaped here first. */
function inline(text: string): string {
  // Code spans and link targets are set aside, so emphasis never reaches inside them.
  const held: string[] = [];
  const hold = (html: string): string => `\u0000${held.push(html) - 1}\u0000`;
  let html = escape(text).replace(/`([^`]+)`/g, (_, code: string) => hold(`<code>${code}</code>`));
  // Links: [text](url), the URL as escaped above, kept only when it is http(s).
  // A URL may hold one level of balanced parentheses (as Wikipedia's do).
  html = html.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label: string, url: string) =>
    /^https?:\/\//i.test(url) ? `${hold(`<a href="${url}">`)}${label}${hold('</a>')}` : label);
  html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)] ?? '');
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; ordered: boolean; start: number; items: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'rule' };

function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '') { i += 1; continue; }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i] as string); i += 1) code.push(lines[i] as string);
      out.push({ kind: 'code', lines: code });
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { out.push({ kind: 'heading', level: (heading[1] as string).length, text: heading[2] as string }); i += 1; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ kind: 'rule' }); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i] as string); i += 1) quoted.push((lines[i] as string).replace(/^\s*>\s?/, ''));
      out.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const item = /^(\s*)(\d+)[.)]\s+(.*)$|^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const list: Block & { kind: 'list' } = { kind: 'list', ordered, start: ordered ? Number(item[2]) : 1, items: [] };
      while (i < lines.length) {
        const current = lines[i] as string;
        const next = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(current) : /^\s*[-*+]\s+(.*)$/.exec(current);
        if (next) { list.items.push([next[1] as string]); i += 1; continue; }
        // An indented line continues the item; a blank line followed by one does too.
        if (/^\s{2,}\S/.test(current) && list.items.length > 0) { list.items.at(-1)?.push(current.trim()); i += 1; continue; }
        if (current.trim() === '' && i + 1 < lines.length && (ordered ? /^\s*\d+[.)]\s/ : /^\s*[-*+]\s/).test(lines[i + 1] as string)) { i += 1; continue; }
        if (current.trim() === '' && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1] as string) && list.items.length > 0) { i += 1; continue; }
        break;
      }
      out.push(list);
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length && (lines[i] as string).trim() !== '' && !/^(#{1,6}\s|\s*```|\s*>|\s*\d+[.)]\s|\s*[-*+]\s)/.test(lines[i] as string); i += 1) paragraph.push((lines[i] as string).trim());
    out.push({ kind: 'paragraph', lines: paragraph });
  }
  return out;
}

function render(block: Block): string {
  switch (block.kind) {
    case 'heading': return `<h${block.level}>${inline(block.text)}</h${block.level}>`;
    case 'paragraph': return `<p>${block.lines.map(inline).join(' ')}</p>`;
    case 'quote': return `<blockquote>${block.lines.map(inline).join('<br>')}</blockquote>`;
    case 'code': return `<pre><code>${escape(block.lines.join('\n'))}</code></pre>`;
    case 'rule': return '<hr>';
    case 'list': {
      const items = block.items.map((lines) => `<li>${lines.map(inline).join('<br>')}</li>`).join('');
      return block.ordered ? `<ol${block.start === 1 ? '' : ` start="${block.start}"`}>${items}</ol>` : `<ul>${items}</ul>`;
    }
  }
}

const STYLE = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:46em';

/** The plain text (front matter dropped) and the HTML a Markdown document is sent as. */
export function markdownEmail(source: string): { readonly text: string; readonly html: string } {
  const text = source.replace(FRONT_MATTER, '').replace(/^\s+/, '');
  const body = blocks(text).map(render).join('\n');
  return { text, html: `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body><div style="${STYLE}">\n${body}\n</div></body></html>\n` };
}
