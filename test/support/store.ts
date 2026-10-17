// A temporary store holding just the module schemas a test is about, opened
// as the package opens its files. Removed afterwards.

import assert from 'node:assert/strict';
import { STATE_FILE, openStore, type ModuleSchema, type Store, type StoreFile } from '../../src/core/store/index.ts';
import { withTempDir, type TempDir } from './temp-dir.ts';

export function withStore(
  modules: readonly ModuleSchema[],
  run: (store: Store, dir: TempDir) => void | Promise<void>,
  file: StoreFile = STATE_FILE,
): () => Promise<void> {
  return withTempDir(async (dir) => {
    const opened = openStore(dir.file('store.sqlite'), file, modules);
    if (!opened.ok) assert.fail(`store: ${JSON.stringify(opened.error)}`);
    try {
      await run(opened.value, dir);
    } finally {
      opened.value.close();
    }
  });
}
