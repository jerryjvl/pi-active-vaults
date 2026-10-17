// Documented behaviour: core.md "documents" — write Markdown with frontmatter,
// preserving the formatting of untouched content. Changing one key must leave
// every other byte of the file as it was, so reviews show only the real change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, parseDocument, updateFrontmatter } from '../../../src/core/documents/index.ts';

const BODY = '\n# Heading\n\nSome   text with  odd   spacing.\n\n---\n\n* list\n';
const ORIGINAL = `---
# top comment
title: "Quoted"   # keep this
labels:
- a
- b   # in list
empty:
nested:
  x: 1
  # inner comment
  y: 2

block: |
  line one
  line two
flow: { z: 1,   w: [1,2] }
last: end
---${BODY}`;

function updated(text: string, changes: Parameters<typeof updateFrontmatter>[1]): string {
  const result = updateFrontmatter(text, changes);
  if (!result.ok) assert.fail(`update failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

test('changing one scalar leaves every other byte alone, including its own trailing comment', () => {
  const next = updated(ORIGINAL, { last: 'changed' });
  assert.equal(next, ORIGINAL.replace('last: end', 'last: changed'));
  const title = updated(ORIGINAL, { title: 'New' });
  assert.equal(title, ORIGINAL.replace('title: "Quoted"', 'title: New'));
});

test('replacing a collection or block value touches only that entry', () => {
  const next = updated(ORIGINAL, { labels: ['x', 'y', 'z'] });
  assert.equal(next, ORIGINAL.replace('labels:\n- a\n- b   # in list\n', 'labels:\n  - x\n  - y\n  - z\n'));
  const block = updated(ORIGINAL, { block: 'one\ntwo\n' });
  assert.ok(block.startsWith(ORIGINAL.slice(0, ORIGINAL.indexOf('block:'))));
  assert.ok(block.endsWith(ORIGINAL.slice(ORIGINAL.indexOf('flow:'))));
  assert.deepEqual((parseDocument(block) as { value: { frontmatter: Record<string, unknown> } }).value.frontmatter['block'], 'one\ntwo\n');
});

test('a key with an empty value can be given one', () => {
  const next = updated(ORIGINAL, { empty: 'filled' });
  assert.equal(next, ORIGINAL.replace('empty:\n', 'empty: filled\n'));
});

test('a new key is appended at the end of the frontmatter', () => {
  const next = updated(ORIGINAL, { provenance: { trace: '01ABC', path: ['a', 'b'] } });
  assert.equal(next, ORIGINAL.replace('last: end\n---', 'last: end\nprovenance:\n  trace: 01ABC\n  path:\n    - a\n    - b\n---'));
});

test('removing a key removes its lines and its trailing comment, and nothing else', () => {
  assert.equal(updated(ORIGINAL, { title: undefined }), ORIGINAL.replace('title: "Quoted"   # keep this\n', ''));
  assert.equal(updated(ORIGINAL, { nested: undefined }), ORIGINAL.replace('nested:\n  x: 1\n  # inner comment\n  y: 2\n', ''));
  assert.equal(updated(ORIGINAL, { absent: undefined }), ORIGINAL, 'removing a missing key is a no-op');
});

test('setting a key to the value it already has changes nothing', () => {
  assert.equal(updated(ORIGINAL, { last: 'end', labels: ['a', 'b'], nested: { x: 1, y: 2 } }), ORIGINAL);
});

test('several changes apply together, in order', () => {
  const next = updated(ORIGINAL, { last: 'z', title: undefined, added: 1 });
  assert.equal(next, ORIGINAL.replace('title: "Quoted"   # keep this\n', '').replace('last: end\n---', 'last: z\nadded: 1\n---'));
});

test('the body is never altered', () => {
  const doc = parseDocument(updated(ORIGINAL, { last: 'x', extra: 'y' }));
  assert.ok(doc.ok);
  assert.equal(doc.value.body, BODY);
});

test('a document without frontmatter gains it ahead of the body; removing from none is a no-op', () => {
  const body = '# Notes\n\ntext\n';
  assert.equal(updated(body, { labels: ['a'] }), `---\nlabels:\n  - a\n---\n${body}`);
  assert.equal(updated(body, { labels: undefined }), body);
});

test('empty frontmatter can be filled', () => {
  assert.equal(updated('---\n---\nbody', { k: 'v' }), '---\nk: v\n---\nbody');
});

test('Windows line endings are kept for new text', () => {
  const crlf = '---\r\ntitle: X\r\n---\r\nbody\r\n';
  assert.equal(updated(crlf, { added: ['a', 'b'] }), '---\r\ntitle: X\r\nadded:\r\n  - a\r\n  - b\r\n---\r\nbody\r\n');
  assert.equal(updated(crlf, { title: 'Y' }), '---\r\ntitle: Y\r\n---\r\nbody\r\n');
});

test('a byte-order mark is preserved', () => {
  assert.equal(updated('﻿---\nk: 1\n---\nb', { k: 2 }), '﻿---\nk: 2\n---\nb');
});

test('frontmatter written in flow style is still editable', () => {
  const next = updated('---\n{ a: 1, b: 2 }\n---\nbody', { b: 3 });
  const doc = parseDocument(next);
  assert.ok(doc.ok);
  assert.deepEqual(doc.value.frontmatter, { a: 1, b: 3 });
  assert.equal(doc.value.body, 'body');
});

test('values that look like other YAML types are written so they read back as the same strings', () => {
  const tricky = ['yes', 'no', 'null', 'true', '123', '1e3', '2026-01-01', ': colon', '# hash', '- dash', '  leading', 'trailing  ', '', 'multi\nline', '{braces}', '[1, 2]', '"quoted"', "it's", '*alias', '&anchor', '!tag', '%percent', '@at', '`tick'];
  for (const value of tricky) {
    const text = updated('---\nk: 0\n---\nb', { k: value });
    const doc = parseDocument(text);
    assert.ok(doc.ok, JSON.stringify(value));
    assert.strictEqual(doc.value.frontmatter['k'], value, JSON.stringify(value));
    assert.equal(doc.value.body, 'b');
  }
});

test('nested data, numbers, booleans and null round-trip', () => {
  const value = { a: [1, 2.5, true, null, 'x'], b: { c: { d: [] }, e: {} }, f: false };
  const doc = parseDocument(updated('---\nk: 0\n---\n', { k: value }));
  assert.ok(doc.ok);
  assert.deepEqual(doc.value.frontmatter['k'], value);
});

test('keys that are empty, multi-line or not strings are refused', () => {
  for (const key of ['', 'a\nb', 'a\0b']) {
    const result = updateFrontmatter(ORIGINAL, { [key]: 'v' });
    assert.equal(result.ok === false && result.error.reason, 'invalid-key', JSON.stringify(key));
  }
});

test('unreadable frontmatter is reported, not overwritten', () => {
  assert.equal(updateFrontmatter('---\nk: [unclosed\n---\nb', { k: 1 }).ok, false);
  assert.equal(updateFrontmatter('---\nno close', { k: 1 }).ok, false);
});

test('a new document is written from data', () => {
  assert.equal(createDocument({ title: 'T', labels: ['a'] }, '# T\n'), '---\ntitle: T\nlabels:\n  - a\n---\n# T\n');
  assert.equal(createDocument({}, '# T\n'), '# T\n');
  const round = parseDocument(createDocument({ k: 'v' }, 'body\n'));
  assert.ok(round.ok && round.value.body === 'body\n');
});
