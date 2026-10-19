// What indexing and searching need: Git, the state store (for each vault's
// accepted `main`), the index store, a clock, and — optionally — the model
// client and the configuration that says which roles exist and which vaults
// they may see. Without models, search is keyword-only.

import type { Clock } from '../clock/index.ts';
import type { InstallationConfig } from '../config/index.ts';
import type { Git } from '../git/index.ts';
import { resolveModel, type ModelClient, type ModelUnavailable, type PermittedModel } from '../models/index.ts';
import type { Result } from '../result/index.ts';
import type { Queryable, Store } from '../store/index.ts';

export interface SearchContext {
  readonly git: Git;
  readonly state: Queryable;
  readonly index: Store;
  readonly clock: Clock;
  readonly models?: {
    readonly client: ModelClient;
    readonly config: Pick<InstallationConfig, 'models' | 'policy'>;
  };
}

/** The role's default model for these vaults, or why there is none (no models at all counts as no default). */
export function searchModel<R extends 'embed' | 'rerank'>(context: SearchContext, role: R, vaults: readonly string[]): Result<PermittedModel<R>, ModelUnavailable> {
  return resolveModel(context.models?.config ?? { models: {}, policy: [] }, role, vaults);
}

/** A vector as sqlite-vec reads it: little-endian float32. */
export function vectorBlob(vector: readonly number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}
