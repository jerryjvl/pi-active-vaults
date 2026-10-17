// Which configured model may receive which vault's content (concepts.md
// "Installation", principles 10 and 11).
//
// A role is usable only when it is configured and the installation's `policy`
// allows it for every vault whose content the call involves: the policy
// records what the installation has agreed to, so a vault no entry names
// sends nothing to any model (fail closed). An unconfigured or disallowed
// role is a value the caller degrades on, never an exception.
//
// `PermittedModel` can only be made here, so every client call has passed
// this check: the clients accept nothing else.

import type { InstallationConfig, ModelEndpoint, ModelRole } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';

declare const permittedBrand: unique symbol;

export interface PermittedModel<R extends ModelRole = ModelRole> {
  readonly role: R;
  readonly endpoint: ModelEndpoint;
  /** The vaults whose content it may receive. */
  readonly vaults: readonly string[];
  readonly [permittedBrand]: true;
}

export type RoleUnavailable =
  | { readonly reason: 'unconfigured'; readonly role: ModelRole }
  | { readonly reason: 'not-allowed'; readonly role: ModelRole; readonly vault: string };

/** The role's model, if it is configured and allowed for every one of `vaults`. */
export function modelFor<R extends ModelRole>(
  config: Pick<InstallationConfig, 'models' | 'policy'>, role: R, vaults: readonly string[],
): Result<PermittedModel<R>, RoleUnavailable> {
  const endpoint = config.models[role];
  if (endpoint === undefined) return err({ reason: 'unconfigured', role });
  const refused = vaults.find((vault) => !config.policy.some((entry) => entry.vaults.includes(vault) && entry.allowModels.includes(role)));
  if (refused !== undefined) return err({ reason: 'not-allowed', role, vault: refused });
  return ok({ role, endpoint, vaults: [...vaults] } as unknown as PermittedModel<R>);
}
