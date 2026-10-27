// Documented behaviour: notifications.md "Use" — a Markdown body is sent as an
// email: its front matter dropped, the Markdown as the plain-text part, and an
// HTML part from a small subset. Everything in the source is escaped, so HTML
// in it is shown rather than rendered, and only http(s) links become links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownEmail } from '../../../src/core/notify/markdown.ts';

const bodyOf = (html: string): string => (/<div[^>]*>\n([\s\S]*)\n<\/div>/.exec(html) ?? [])[1] ?? '';

test('the front matter is dropped from both parts', () => {
  const { text, html } = markdownEmail('---\ntype: digest\ndate: 2026-10-19\n---\n\n# Digest\n');
  assert.equal(text, '# Digest\n');
  assert.equal(bodyOf(html), '<h1>Digest</h1>');
});

test('a digest renders as headings and numbered items, each with its sources on a line of its own', () => {
  const { html } = markdownEmail([
    '# Digest — 19 October 2026', '', '## Consoles', '',
    '1. **Xbox Labs formalised** A *small* team. *(changed)*', '   — [Windows Central](https://example.org/a?x=1&y=2) (2026-10-13) · [MondoXbox](https://example.org/b)', '',
    '2. **Second** Text.', '   — [S](https://example.org/c)', '',
    '## Not checked today', '', '- **Games**: research failed',
  ].join('\n'));
  assert.equal(bodyOf(html), [
    '<h1>Digest — 19 October 2026</h1>',
    '<h2>Consoles</h2>',
    '<ol><li><strong>Xbox Labs formalised</strong> A <em>small</em> team. <em>(changed)</em><br>— <a href="https://example.org/a?x=1&amp;y=2">Windows Central</a> (2026-10-13) · <a href="https://example.org/b">MondoXbox</a></li>'
      + '<li><strong>Second</strong> Text.<br>— <a href="https://example.org/c">S</a></li></ol>',
    '<h2>Not checked today</h2>',
    '<ul><li><strong>Games</strong>: research failed</li></ul>',
  ].join('\n'));
});

test('HTML in the document is shown, not rendered, and only http(s) links become links', () => {
  const { html } = markdownEmail([
    'A <script>alert(1)</script> and <img src=x onerror=alert(1)>.',
    '[click](javascript:alert(1)) [mail](mailto:a@b.c) [ok](https://example.org/"onmouseover="x) [wiki](https://en.wikipedia.org/wiki/Mercury_(planet))',
    '`<b>code</b>` and **<i>bold</i>**',
  ].join('\n'));
  const body = bodyOf(html);
  assert.ok(!/<script|<img|<i>|<b>|javascript:|mailto:/.test(body), body);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body, /click mail /, 'non-http(s) links are left as their text');
  assert.match(body, /<a href="https:\/\/example\.org\/&quot;onmouseover=&quot;x">ok<\/a>/, 'a quote cannot leave the attribute');
  assert.match(body, /<a href="https:\/\/en\.wikipedia\.org\/wiki\/Mercury_\(planet\)">wiki<\/a>/, 'balanced parentheses stay in the URL');
  assert.match(body, /<code style="font-family:[^"]*monospace">&lt;b&gt;code&lt;\/b&gt;<\/code>/, 'code is monospace by an inline style, which mail clients keep');
  assert.match(bodyOf(markdownEmail('[a _b_](https://e.org/x_y_z__w__) *it*').html), /<a href="https:\/\/e\.org\/x_y_z__w__">a <em>b<\/em><\/a> <em>it<\/em>/, 'emphasis never reaches into a URL');
});

test('paragraphs, quotes, code blocks and rules', () => {
  const { html } = markdownEmail('One line\nand the next.\n\n> Quoted\n> twice\n\n```\nraw *not* bold\n```\n\n---\n\nEnd.');
  assert.equal(bodyOf(html), '<p>One line and the next.</p>\n<blockquote>Quoted<br>twice</blockquote>\n<pre><code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">raw *not* bold</code></pre>\n<hr>\n<p>End.</p>');
});
