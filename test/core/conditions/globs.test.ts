// Documented behaviour: concepts.md — `paths` are path globs relative to the
// vault root, used by conditions and merge rules. A glob that matched too
// little would let a change escape a merge rule, so `*` and `**` also match
// dot-files and `.vault/`, and anything the syntax does not define is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globIssue, matchesGlob } from '../../../src/core/conditions/index.ts';

test('** matches any number of directories, including none', () => {
  assert.ok(matchesGlob('topics/cars/a.md', 'topics/cars/**'));
  assert.ok(matchesGlob('topics/cars/x/y/a.md', 'topics/cars/**'));
  assert.ok(!matchesGlob('topics/boats/a.md', 'topics/cars/**'));
  assert.ok(matchesGlob('a.md', '**/a.md'));
  assert.ok(matchesGlob('x/y/a.md', '**/a.md'));
  assert.ok(matchesGlob('x/a.md/b', 'x/**/b'));
  assert.ok(matchesGlob('x/b', 'x/**/b'));
});

test('** alone matches every path, including dot-files and the .vault directory', () => {
  for (const path of ['a.md', '.hidden', '.vault/scripts/run.sh', 'deep/.dot/x']) assert.ok(matchesGlob(path, '**'), path);
});

test('* and ? stay within one path segment', () => {
  assert.ok(matchesGlob('topics/a.md', 'topics/*.md'));
  assert.ok(matchesGlob('topics/.a.md', 'topics/*.md'));
  assert.ok(!matchesGlob('topics/x/a.md', 'topics/*.md'));
  assert.ok(matchesGlob('notes/a1.md', 'notes/a?.md'));
  assert.ok(!matchesGlob('notes/a/.md', 'notes/a?.md'));
});

test('braces offer alternatives', () => {
  assert.ok(matchesGlob('topics/a.md', 'topics/*.{md,txt}'));
  assert.ok(matchesGlob('topics/a.txt', 'topics/*.{md,txt}'));
  assert.ok(!matchesGlob('topics/a.pdf', 'topics/*.{md,txt}'));
});

test('everything else is literal, including regular-expression characters', () => {
  assert.ok(matchesGlob('a+b (1).md', 'a+b (1).md'));
  assert.ok(!matchesGlob('aab (1).md', 'a+b (1).md'));
  assert.ok(matchesGlob('price$.md', 'price$.md'));
  assert.ok(!matchesGlob('Topics/a.md', 'topics/*.md'), 'case-sensitive, as Git is');
});

test('patterns the syntax does not define are refused, and matching one is a programming error', () => {
  for (const pattern of ['', '/abs/**', 'a\\b', '[ab].md', 'a/{b', 'a/{b,{c}}', 'a/../b', './a', 'a//b']) {
    assert.ok(globIssue(pattern) !== undefined, JSON.stringify(pattern));
  }
  assert.equal(globIssue('topics/**/*.{md,txt}'), undefined);
  assert.throws(() => matchesGlob('a', '[a]'));
});
