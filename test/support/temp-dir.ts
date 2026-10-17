// A throwaway directory for tests that need files; removed by `cleanup`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir {
  readonly path: string;
  file(...parts: string[]): string;
  cleanup(): void;
}

export function createTempDir(prefix = 'pav-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    file: (...parts) => join(path, ...parts),
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Wraps a test body so its directory is always removed afterwards. */
export function withTempDir(run: (dir: TempDir) => void | Promise<void>, prefix?: string): () => Promise<void> {
  return async () => {
    const dir = createTempDir(prefix);
    try {
      await run(dir);
    } finally {
      dir.cleanup();
    }
  };
}
