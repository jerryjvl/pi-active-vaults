// The package's two local stores, each opened with every module that keeps
// tables in it. Modules own their migrations; this is the one place that lists
// them, so every surface (CLI, extension, daemon) opens a file with the same
// complete set — store refuses a file holding a module it was not given.
//
// Order matters only for foreign keys: a module comes after any whose tables
// it references, which the layers already imply.

import { actorsSchema } from '../actors/index.ts';
import { budgetsSchema } from '../budgets/index.ts';
import type { InstallationPaths } from '../config/index.ts';
import { forgeSchema } from '../forge/index.ts';
import { integritySchema, readsSchema } from '../integrity/index.ts';
import { notifySchema } from '../notify/index.ts';
import { queueSchema } from '../queue/index.ts';
import { searchSchema } from '../search/index.ts';
import type { Result } from '../result/index.ts';
import {
  INDEX_FILE,
  STATE_FILE,
  openStore,
  type ModuleSchema,
  type Store,
  type StoreError,
  type StoreOptions,
} from '../store/index.ts';

export const STATE_MODULES: readonly ModuleSchema[] = [integritySchema, actorsSchema, budgetsSchema, queueSchema, notifySchema, forgeSchema];

export const INDEX_MODULES: readonly ModuleSchema[] = [searchSchema, readsSchema];

export function openStateStore(paths: Pick<InstallationPaths, 'stateDb'>, options?: StoreOptions): Result<Store, StoreError> {
  return openStore(paths.stateDb, STATE_FILE, STATE_MODULES, options);
}

export function openIndexStore(paths: Pick<InstallationPaths, 'indexDb'>, options?: StoreOptions): Result<Store, StoreError> {
  return openStore(paths.indexDb, INDEX_FILE, INDEX_MODULES, options);
}
