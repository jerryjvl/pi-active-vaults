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
