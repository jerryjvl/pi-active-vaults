// Documented behaviour: architecture.md "Local storage" — each module owns the
// migrations for its own tables, and every part of the package opens a file
// with the same complete list, assembled once by the operations layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INDEX_MODULES, STATE_MODULES, openIndexStore, openStateStore } from '../../../src/core/operations/index.ts';
import type { ModuleSchema } from '../../../src/core/store/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/core');

function isModuleSchema(value: unknown): value is ModuleSchema {
  return typeof value === 'object' && value !== null &&
    typeof (value as ModuleSchema).module === 'string' && Array.isArray((value as ModuleSchema).migrations);
}

/** Every module schema exported from a core module's public surface. */
async function exportedSchemas(): Promise<{ from: string; schema: ModuleSchema }[]> {
  const found: { from: string; schema: ModuleSchema }[] = [];
  for (const module of readdirSync(coreRoot)) {
    const index = join(coreRoot, module, 'index.ts');
    if (!existsSync(index)) continue;
    const exports: Record<string, unknown> = await import(pathToFileURL(index).href);
    for (const value of Object.values(exports)) if (isModuleSchema(value)) found.push({ from: module, schema: value });
  }
  return found;
}

test('every module schema a core module exports is assembled into exactly one store file', async () => {
  for (const { from, schema } of await exportedSchemas()) {
    const places = [STATE_MODULES, INDEX_MODULES].filter((list) => list.includes(schema)).length;
    assert.equal(places, 1, `${from} exports schema "${schema.module}"`);
  }
});

test('the state store opens at the installation paths with every state module\'s tables', withTempDir((dir) => {
  const store = openStateStore({ stateDb: dir.file('nested', 'state.sqlite') });
  if (!store.ok) assert.fail(JSON.stringify(store.error));
  assert.deepEqual(Object.keys(store.value.versions).sort(), STATE_MODULES.map((m) => m.module).sort());
  store.value.close();
}));

test('the index store opens at the installation paths with every index module\'s tables', withTempDir((dir) => {
  const store = openIndexStore({ indexDb: dir.file('index.sqlite') });
  if (!store.ok) assert.fail(JSON.stringify(store.error));
  assert.deepEqual(Object.keys(store.value.versions).sort(), INDEX_MODULES.map((m) => m.module).sort());
  store.value.close();
}));
