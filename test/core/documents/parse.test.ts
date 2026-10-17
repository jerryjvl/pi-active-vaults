// Documented behaviour: concepts.md "Document" — Markdown with optional YAML
// frontmatter; the frontmatter is what the package enforces. A document that
// cannot be read unambiguously is an error value, never a guess (gates fail closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../../../src/core/documents/index.ts';

function parsed(text: string) {
  const result = parseDocument(text);
  if (!result.ok) assert.fail(`expected a document: ${JSON.stringify(result.error)}`);
  return result.value;
}

function reason(text: string): string | undefined {
  const result = parseDocument(text);
  return result.ok ? undefined : result.error.reason;
}

test('frontmatter and body are separated, and the body is kept exactly', () => {
  const doc = parsed('---\ntitle: Cars\nlabels: [a, b]\nbudget: { tokens: 1000, ttl: 5m }\n---\n\n# Heading\n\nText.\n');
  assert.deepEqual(doc.frontmatter, { title: 'Cars', labels: ['a', 'b'], budget: { tokens: 1000, ttl: '5m' } });
  assert.equal(doc.body, '\n# Heading\n\nText.\n');
  assert.equal(doc.hasFrontmatter, true);
});

test('a document without frontmatter is all body', () => {
  for (const text of ['# Just text\n', '', 'Intro\n\n---\n\nnot frontmatter: true\n---\n']) {
    const doc = parsed(text);
    assert.deepEqual(doc.frontmatter, {});
    assert.equal(doc.body, text);
    assert.equal(doc.hasFrontmatter, false);
  }
});

test('a byte-order mark before the opening delimiter is tolerated', () => {
  const doc = parsed('﻿---\nk: v\n---\nbody');
  assert.deepEqual(doc.frontmatter, { k: 'v' });
  assert.equal(doc.body, 'body');
});

test('Windows line endings parse and leave the body untouched', () => {
  const doc = parsed('---\r\ntitle: X\r\n---\r\nline one\r\nline two\r\n');
  assert.deepEqual(doc.frontmatter, { title: 'X' });
  assert.equal(doc.body, 'line one\r\nline two\r\n');
});

test('the closing delimiter may be --- or ...; empty and comment-only frontmatter are empty maps', () => {
  assert.deepEqual(parsed('---\nk: 1\n...\nbody').frontmatter, { k: 1 });
  assert.deepEqual(parsed('---\n---\nbody').frontmatter, {});
  assert.deepEqual(parsed('---\n# only a comment\n---\nbody').frontmatter, {});
});

test('YAML 1.2 core types: dates and words like yes/no stay strings, so nothing is silently coerced', () => {
  const doc = parsed('---\ndate: 2026-01-01\nflag: yes\nanswer: no\nnumber: 12\nempty:\nreal: true\n---\n');
  assert.deepEqual(doc.frontmatter, { date: '2026-01-01', flag: 'yes', answer: 'no', number: 12, empty: null, real: true });
});

test('unterminated frontmatter is an error, not treated as body', () => {
  assert.equal(reason('---\ntitle: X\nno closing delimiter\n'), 'unterminated-frontmatter');
});

test('invalid YAML is an error that names the line but never repeats the content', () => {
  const result = parseDocument('---\ntitle: ok\napi_key: [sk-live-123, \n---\nbody');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.reason, 'invalid-frontmatter');
    assert.ok(!JSON.stringify(result.error).includes('sk-live-123'));
  }
});

test('frontmatter that is not a mapping, or repeats a key, is rejected', () => {
  assert.equal(reason('---\n- a\n- b\n---\n'), 'frontmatter-not-a-mapping');
  assert.equal(reason('---\njust a string\n---\n'), 'frontmatter-not-a-mapping');
  assert.equal(reason('---\nk: 1\nk: 2\n---\n'), 'invalid-frontmatter');
});

test('an alias-expansion bomb is refused instead of exhausting memory', () => {
  const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
  let previous = 'a';
  for (const name of ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
    levels.push(`${name}: &${name} [${Array(10).fill(`*${previous}`).join(', ')}]`);
    previous = name;
  }
  assert.equal(reason(`---\n${levels.join('\n')}\n---\n`), 'invalid-frontmatter');
});

test('YAML tags cannot construct anything but plain data', () => {
  const doc = parseDocument('---\nk: !!js/function "function () { return 1 }"\n---\n');
  if (doc.ok) assert.equal(typeof doc.value.frontmatter['k'], 'string');
});
