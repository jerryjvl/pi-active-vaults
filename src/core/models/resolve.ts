// Which configured model answers a request, and may receive a vault's content
// (concepts.md "Models", principles 10 and 11).
//
// A request names a model and never guarantees one: a name that is not
// configured is answered by the role's default — the entry named after the
// role — marked as substituted; a name configured with another role is
// refused. The installation's `policy` is checked on the model actually used,
// for every vault whose content the call involves: a configured model that is
// not allowed is never replaced by the default, and a vault no entry names
// sends nothing to any model (fail closed). A missing, refused or disallowed
// model is a value the caller degrades on — a job that does not run, an axis
// left unjudged, keyword-only search — never an exception.
//
// `PermittedModel` can only be made here, so every client call and every
// agent spawn has passed this check: they accept nothing else.

import type { InstallationConfig, ModelEntry, ModelRole } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';

declare const permittedBrand: unique symbol;

export interface PermittedModel<R extends ModelRole = ModelRole> {
  readonly role: R;
  /** The configured name of the model used. */
  readonly name: string;
  /** The requested name that is not configured, when the role's default answers instead. */
  readonly substitutedFor?: string;
  readonly entry: ModelEntry & { readonly role: R };
  /** The vaults whose content it may receive. */
  readonly vaults: readonly string[];
  readonly [permittedBrand]: true;
}

export type ModelUnavailable =
  | { readonly reason: 'no-default'; readonly role: ModelRole; readonly requested?: string }
  | { readonly reason: 'wrong-role'; readonly role: ModelRole; readonly name: string; readonly actual: ModelRole }
  | { readonly reason: 'not-allowed'; readonly role: ModelRole; readonly name: string; readonly vault: string };

type ModelsConfig = Pick<InstallationConfig, 'models' | 'policy'>;

/**
 * The model of `role` that answers a request for `requested` (else the
 * role's default), if it is configured and allowed for every one of `vaults`.
 */
export function resolveModel<R extends ModelRole>(
  config: ModelsConfig, role: R, vaults: readonly string[], requested?: string,
): Result<PermittedModel<R>, ModelUnavailable> {
  // Own properties only: a requested name comes from a document, and `toString` is not a model.
  const asked = requested !== undefined && Object.hasOwn(config.models, requested) ? config.models[requested] : undefined;
  if (asked !== undefined && asked.role !== role) return err({ reason: 'wrong-role', role, name: requested as string, actual: asked.role });
  const name = asked === undefined ? role : (requested as string);
  const entry = asked ?? config.models[role];
  if (entry === undefined) return err({ reason: 'no-default', role, ...(requested === undefined ? {} : { requested }) });
  const refused = vaults.find((vault) => !config.policy.some((p) => p.vaults.includes(vault) && p.allowModels.includes(name)));
  if (refused !== undefined) return err({ reason: 'not-allowed', role, name, vault: refused });
  return ok({
    role, name, ...(asked === undefined && requested !== undefined ? { substitutedFor: requested } : {}), entry, vaults: [...vaults],
  } as unknown as PermittedModel<R>);
}
