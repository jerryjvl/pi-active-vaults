// Documented behaviour: one access path per external system (AGENTS.md §4,
// core.md "Rules") — SQLite only through `store`, processes only through
// `process`. Enforced by reading the import graph, like the layer test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSpecifiers } from '../support/layers.ts';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.ts$/.test(entry) ? [full] : [];
  });
}

function importersOf(specifier: string): string[] {
  return sourceFiles(srcRoot)
    .filter((file) => importSpecifiers(readFileSync(file, 'utf8')).includes(specifier))
    .map((file) => relative(srcRoot, file).split('\\').join('/'));
}

test('node:sqlite is imported only by the store module', () => {
  assert.deepEqual(importersOf('node:sqlite'), ['core/store/index.ts']);
});

test('processes are started only by the process module', () => {
  assert.deepEqual([...importersOf('node:child_process'), ...importersOf('child_process')], ['core/process/index.ts']);
});

test('only the git module knows how to talk to git', () => {
  const offenders = sourceFiles(srcRoot)
    .filter((file) => !relative(srcRoot, file).split('\\').join('/').startsWith('core/git/'))
    .filter((file) => /['"`]git['"`]/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(srcRoot, file));
  assert.deepEqual(offenders, []);
});
