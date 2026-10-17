// Documented behaviour: core.md "Search" — each chunk is indexed with a header
// naming its vault, document title and heading path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument } from '../../../src/core/search/index.ts';

test('a document is split at its headings, each chunk carrying its heading path', () => {
  const text = [
    '---', 'labels: [net]', '---',
    'Intro before any heading.',
    '# Network', 'The house network.',
    '## Router', 'The router is in the hall.',
    '### Ports', 'Four ports.',
    '## Switch', 'A switch in the office.',
  ].join('\n');
  const { title, chunks } = chunkDocument('home', 'topics/network.md', text);
  assert.equal(title, 'Network');
  assert.deepEqual(chunks.map((c) => [c.heading, c.body]), [
    [[], 'Intro before any heading.'],
    [['Network'], 'The house network.'],
    [['Network', 'Router'], 'The router is in the hall.'],
    [['Network', 'Router', 'Ports'], 'Four ports.'],
    [['Network', 'Switch'], 'A switch in the office.'],
  ]);
  assert.equal(chunks[2]?.header, 'home · Network · Network › Router');
  assert.equal(chunks[0]?.header, 'home · Network');
});

test('the title is the frontmatter title, else the first top-level heading, else the file name', () => {
  assert.equal(chunkDocument('v', 'a/b.md', '---\ntitle: Given\n---\n# Heading\nx').title, 'Given');
  assert.equal(chunkDocument('v', 'a/b.md', '## Second level\nx\n# Top\ny').title, 'Top');
  assert.equal(chunkDocument('v', 'a/brake-pads.md', 'Just text.').title, 'brake-pads');
});

test('lines inside fenced code are content, not headings', () => {
  const { chunks } = chunkDocument('v', 'a.md', '# Script\n```sh\n# not a heading\necho hi\n```\n~~~\n## nor this\n~~~');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]?.body ?? '', /# not a heading[\s\S]*## nor this/);
});

test('long sections are split at paragraphs, and an overlong paragraph is cut, keeping the heading path', () => {
  const paragraph = (n: number) => `Paragraph ${n} ${'word '.repeat(150)}`.trim();
  const long = ['# Long', ...Array.from({ length: 5 }, (_, i) => paragraph(i)).flatMap((p) => [p, ''])].join('\n');
  const { chunks } = chunkDocument('v', 'a.md', long);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.deepEqual(chunk.heading, ['Long']);
    assert.ok(chunk.body.length <= 1500, `${chunk.body.length}`);
  }
  const huge = chunkDocument('v', 'b.md', `# Huge\n${'x'.repeat(4000)}`).chunks;
  assert.deepEqual(huge.map((c) => c.body.length), [1500, 1500, 1000]);
});

test('empty sections and unreadable frontmatter do not lose content', () => {
  const { chunks } = chunkDocument('v', 'a.md', '# Empty\n\n## Full\nText.');
  assert.deepEqual(chunks.map((c) => c.heading), [['Empty', 'Full']]);
  const broken = chunkDocument('v', 'broken.md', '---\nlabels: [unclosed\n---\nStill searchable.');
  assert.equal(broken.title, 'broken');
  assert.ok(broken.chunks.some((c) => c.body.includes('Still searchable.')));
});
