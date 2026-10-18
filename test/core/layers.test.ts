// Documented behaviour: dependencies point down, without cycles, and the core
// never imports an adapter or Pi (core.md "Layers" and "Rules").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCycles, checkLayers, importSpecifiers } from '../support/layers.ts';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function fixture(files: Record<string, string>): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'pav-layers-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the real source tree respects the layers and has no import cycles', () => {
  assert.deepEqual(checkLayers(srcRoot), []);
  assert.deepEqual(checkCycles(srcRoot), []);
});

test('modules of one layer importing each other in a circle is a violation', () => {
  const f = fixture({
    'core/policy/index.ts': "import { a } from '../actors/index.ts';",
    'core/actors/index.ts': "import { e } from '../events/index.ts';",
    'core/events/index.ts': "import { p } from '../policy/rules.ts';",
  });
  try {
    assert.equal(checkLayers(f.root).length, 0, 'the layers alone allow it');
    assert.match(checkCycles(f.root)[0]?.message ?? '', /import cycle: actors -> events -> policy -> actors/);
  } finally {
    f.cleanup();
  }
});

test('importSpecifiers finds static, re-export, side-effect and dynamic imports', () => {
  const source = [
    "import { a } from './a.ts';",
    "import type { B } from '../b/index.ts';",
    "export * from './c.ts';",
    "import './d.ts';",
    "const e = await import('./e.ts');",
    "// import { nope } from './in-a-comment-is-tolerated.ts'",
  ].join('\n');
  const found = importSpecifiers(source);
  for (const spec of ['./a.ts', '../b/index.ts', './c.ts', './d.ts', './e.ts']) {
    assert.ok(found.includes(spec), spec);
  }
});

test('a lower layer importing a higher one is a violation', () => {
  const f = fixture({
    'core/store/index.ts': "import { x } from '../policy/index.ts';",
    'core/policy/index.ts': 'export const x = 1;',
  });
  try {
    const violations = checkLayers(f.root);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!.message, /store \(L0\) imports policy \(L1\)/);
  } finally {
    f.cleanup();
  }
});

test('importing the same or a lower layer is allowed', () => {
  const f = fixture({
    'core/policy/index.ts': "import { s } from '../store/index.ts';\nimport { c } from '../contracts/index.ts';",
    'core/contracts/index.ts': 'export const c = 1;',
    'core/store/index.ts': 'export const s = 1;',
  });
  try {
    assert.deepEqual(checkLayers(f.root), []);
  } finally {
    f.cleanup();
  }
});

test('the core importing an adapter is a violation', () => {
  const f = fixture({
    'core/git/index.ts': "import { run } from '../../cli/main.ts';",
    'cli/main.ts': 'export const run = 1;',
  });
  try {
    assert.match(checkLayers(f.root)[0]!.message, /adapter "cli"/);
  } finally {
    f.cleanup();
  }
});

test('the core importing Pi is a violation', () => {
  const f = fixture({ 'core/git/index.ts': "import { x } from '@earendil-works/pi-coding-agent';" });
  try {
    assert.match(checkLayers(f.root)[0]!.message, /pi-coding-agent/);
  } finally {
    f.cleanup();
  }
});

test('a core module without a layer assignment fails closed', () => {
  const f = fixture({ 'core/mystery/index.ts': 'export const x = 1;' });
  try {
    assert.match(checkLayers(f.root)[0]!.message, /not assigned to a layer/);
  } finally {
    f.cleanup();
  }
});

test('adapters may import the core', () => {
  const f = fixture({
    'cli/main.ts': "import { x } from '../core/operations/index.ts';",
    'core/operations/index.ts': 'export const x = 1;',
  });
  try {
    assert.deepEqual(checkLayers(f.root), []);
  } finally {
    f.cleanup();
  }
});
