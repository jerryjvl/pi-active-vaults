// MCP (mcp.md): what a profile's client sees and may do — every decision the
// MCP adapter needs, so it only carries messages.
//
// Invariants:
//  - a client sees exactly the operations its profile permits for at least
//    one vault (`permittedOperations`), as `vault_<operation>` tools in the
//    catalogue's order; no other tool exists or is callable;
//  - a call names its vaults as its operation's scope takes them (`vault`
//    for one, `vaults` for many, or a `<vault-id>:<path>`); every vault it
//    acts on must permit the operation. An operation over many that names
//    none acts on the permitted ones only. A vault the profile may not touch
//    is refused exactly as one that does not exist, so a profile cannot learn
//    which vaults there are;
//  - the caller is the profile: its owner is the person for owner acts (none
//    without one), it is no actor, and it is always tainted — the package
//    cannot know what the client read, so its commits carry `Vault-Tainted`;
//  - parameters are checked by the operation's own specs on the `mcp`
//    surface, as on every surface; schemas carry no value from this machine;
//  - every response carries the notice of each vault it acted on with an
//    unaccepted change;
//  - a bearer token is compared in constant time, and an empty one matches
//    nothing;
//  - on an endpoint, `/mcp/<name>` is that profile; `/mcp` and a name the
//    endpoint does not have are its default (the profile alone on it, or the
//    one marked `default`), or nothing; a deeper path is nothing. The path only
//    chooses: the chosen profile's token still decides (mcp.md "Sharing an
//    endpoint").

import { timingSafeEqual } from 'node:crypto';
import { withoutSteps } from '../git/index.ts';
import { isRecord } from '../result/index.ts';
import type { RegisteredVault } from '../registry/index.ts';
import { CATALOGUE, chooseVaults, isRequired, paramsOn, placeVaultPaths, runOperation } from './catalogue.ts';
import type { OperationContext } from './context.ts';
import { describeCommandLineError } from './commandline.ts';
import { invalid, refused } from './messages.ts';
import { unacceptedNotices } from './notices.ts';
import { endpointKey, mayCall, permittedOperations, type Endpoint, type McpProfile, type Permission } from './permissions.ts';
import { modelResult, type ModelResult } from './results.ts';
import type { Caller, Operation, OperationOutcome, ParamSpec } from './types.ts';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface McpTool {
  readonly name: string;
  readonly operation: Operation;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

const TOOL_PREFIX = 'vault_';

function paramSchema(spec: ParamSpec): JsonSchema {
  const description = spec.description;
  switch (spec.kind) {
    case 'string':
      return spec.choices === undefined ? { type: 'string', description } : { type: 'string', enum: [...spec.choices], description };
    case 'strings':
      return { type: 'array', items: { type: 'string' }, description };
    case 'integer':
      return { type: 'integer', description };
    case 'boolean':
      return { type: 'boolean', description };
  }
}

/** The parameter a call names its vaults with: `vaults` for an operation over many, else `vault`. */
function vaultParam(operation: Operation): { name: 'vault' | 'vaults'; schema: JsonSchema } {
  return operation.vault === 'many'
    ? { name: 'vaults', schema: { type: 'array', items: { type: 'string' }, description: 'The vault IDs to act on (default: every vault this client may use)' } }
    : { name: 'vault', schema: { type: 'string', description: 'The vault ID to act on, unless a <vault-id>:<path> names it' } };
}

/** The tool's input: the operation's MCP parameters, and the vault to act on. */
function inputSchemaOf(operation: Operation): JsonSchema {
  const specs = paramsOn(operation, 'mcp');
  const vault = vaultParam(operation);
  const required = specs.filter((s) => isRequired(s, 'mcp')).map((s) => s.name);
  return {
    type: 'object',
    properties: { ...Object.fromEntries(specs.map((s) => [s.name, paramSchema(s)])), [vault.name]: vault.schema },
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
  };
}

/** The tools a client of `profile` sees, in a stable order. */
export function mcpTools(profile: McpProfile): McpTool[] {
  const permitted = new Set<string>(permittedOperations(profile));
  return CATALOGUE.filter((operation) => operation.surfaces.mcp && permitted.has(operation.name))
    .map((operation) => ({ name: `${TOOL_PREFIX}${operation.name}`, operation, description: operation.summary, inputSchema: inputSchemaOf(operation) }));
}

/** Who a call through `profile` is. */
function callerOf(profile: McpProfile): Caller {
  return { surface: 'mcp', via: profile.name, tainted: true, ...(profile.owner === undefined ? {} : { person: profile.owner }) };
}

const notPermitted = (operation: Operation, vault: string): OperationOutcome =>
  refused(`"${operation.name}" is not permitted for vault "${vault}" through this profile.`, { reason: 'not-permitted', operation: operation.name, vault });

/** The vaults a call acts on, each permitting the operation; or why not. */
function vaultsOf(
  context: OperationContext, profile: McpProfile, operation: Operation, input: Readonly<Record<string, unknown>>,
): { vaults: RegisteredVault[]; params: Record<string, unknown> } | OperationOutcome {
  const { installation } = context;
  const key = vaultParam(operation).name;
  const { [key]: given, ...rest } = input;
  const names = typeof given === 'string' ? [given] : Array.isArray(given) ? given.filter((n): n is string => typeof n === 'string') : [];
  if (given !== undefined && names.length !== (Array.isArray(given) ? given.length : 1)) return invalid(`${key}: must be ${key === 'vault' ? 'a vault ID' : 'a list of vault IDs'}.`);
  const placed = placeVaultPaths(installation, operation, 'mcp', rest, names);
  // A name, or a path's `<vault-id>:`, that is no registered vault is refused like one the profile may not touch.
  const unknown = [...placed.named, ...placed.unregistered].find((name) => !installation.vaults.some((v) => v.id === name));
  if (unknown !== undefined) return notPermitted(operation, unknown);
  const permission = operation.name as Permission;
  if (operation.vault === 'many' && placed.named.length === 0) {
    return { vaults: installation.vaults.filter((v) => mayCall(profile, permission, v.id)), params: placed.params };
  }
  const chosen = chooseVaults(installation, operation, placed.named);
  if (!chosen.ok) return invalid(describeCommandLineError(chosen.error, operation, 'mcp'));
  if (chosen.value.length === 0) return invalid(`Name the vault to act on (${key}), so its permission can be checked.`);
  const denied = chosen.value.find((v) => !mayCall(profile, permission, v.id));
  return denied === undefined ? { vaults: chosen.value, params: placed.params } : notPermitted(operation, denied.id);
}

/** Calls tool `name` with `input` for a client of `profile`; what the client gets back. */
export async function callMcpTool(context: OperationContext, profile: McpProfile, name: string, input: unknown): Promise<ModelResult> {
  const tool = mcpTools(profile).find((t) => t.name === name);
  if (tool === undefined) return modelResult(refused(`No tool "${name}" for this client.`), []);
  if (input !== undefined && !isRecord(input)) return modelResult(invalid('The arguments must be an object.'), []);
  const chosen = vaultsOf(context, profile, tool.operation, input ?? {});
  if ('status' in chosen) return modelResult(chosen, []);
  const outcome = await runOperation(context, tool.operation, 'mcp', { vaults: chosen.vaults, params: chosen.params, caller: callerOf(profile) });
  // A client on another machine gets no paths of this one: steps that name them are left out.
  const notices = (await unacceptedNotices(context, chosen.vaults)).map((n) => withoutSteps(n.notice));
  return modelResult({ ...outcome, text: withoutSteps(outcome.text) }, notices);
}

/** The path an endpoint serves MCP at; a shared endpoint serves each profile below it. */
export const MCP_PATH = '/mcp';

export interface McpEndpointProfiles {
  readonly endpoint: Endpoint;
  /** In the order they are configured. */
  readonly profiles: readonly McpProfile[];
}

/** Each endpoint the profiles listen on, with the profiles it serves, in the order they are configured. */
export function mcpEndpoints(profiles: readonly McpProfile[]): McpEndpointProfiles[] {
  const found = new Map<string, { endpoint: Endpoint; profiles: McpProfile[] }>();
  for (const profile of profiles) {
    if (profile.listen === undefined) continue;
    const key = endpointKey(profile.listen);
    const entry = found.get(key) ?? { endpoint: profile.listen, profiles: [] };
    entry.profiles.push(profile);
    found.set(key, entry);
  }
  return [...found.values()];
}

/** The profile a request's path chooses among an endpoint's profiles; undefined when none. */
export function profileForPath(profiles: readonly McpProfile[], pathname: string): McpProfile | undefined {
  const fallback = profiles.length === 1 ? profiles[0] : profiles.find((p) => p.default);
  if (pathname === MCP_PATH) return fallback;
  if (!pathname.startsWith(`${MCP_PATH}/`)) return undefined;
  const name = pathname.slice(MCP_PATH.length + 1);
  if (name.includes('/')) return undefined;
  return profiles.find((p) => p.name === name) ?? fallback;
}

/** Whether an `Authorization` header carries exactly `token` as a bearer token (the scheme's name in any case). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || token === '') return false;
  const found = /^Bearer (.+)$/i.exec(header);
  if (found?.[1] === undefined) return false;
  const given = Buffer.from(found[1]);
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
