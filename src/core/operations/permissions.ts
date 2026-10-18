// Permission sets (mcp.md "Permissions", "Profiles and layering"): what an
// MCP profile may do, vault by vault.
//
// A permission is the name of an operation, and a set of them is plain: no
// permission implies another — `accept` does not bring `review`, `commit` does
// not bring `write`. Groups are shorthand that expand to sets when the config
// is read; nothing else about them survives. A profile's base set is empty
// unless given; a vault's entry replaces or edits it with the contract list
// syntax (`applyListOps`, the one implementation of it). So with no `mcp`
// section, or a profile without permissions, nothing is permitted.
//
// Invariants:
//  - the section is validated strictly when the config loads: an unknown key,
//    operation, group or vault is an issue, so a typo cannot widen or silently
//    narrow what a client may do; issues never repeat a value (a token may
//    have been pasted by mistake);
//  - `accept` is an owner act: a profile that permits it anywhere must name the
//    owner whose approvals it records — checked here and again at the call;
//  - every HTTP endpoint has a token; a socket or pipe path is protected by
//    being the user's own instead.

import { parseSecretRef, type SecretRef } from '../config/index.ts';
import { applyListOps } from '../contracts/index.ts';
import type { HttpEndpoint } from '../socket/index.ts';
import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

/** Every permission, in the order clients are shown the operations. */
export const PERMISSIONS = [
  'search', 'read', 'contract', 'jobs', 'status', 'trace',
  'write', 'commit', 'propose',
  'run', 'trigger', 'script', 'notify',
  'review', 'accept', 'reindex',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_GROUPS: Readonly<Record<string, readonly Permission[]>> = {
  '@read': ['search', 'read', 'contract', 'jobs', 'status', 'trace'],
  '@propose': ['write', 'commit', 'propose'],
  '@run': ['run', 'trigger', 'script', 'notify'],
  '@admin': ['review', 'accept', 'reindex'],
};

/** Where a profile is served: a loopback address and port, or a socket or pipe path. */
export type Endpoint = HttpEndpoint;

export interface McpProfile {
  readonly name: string;
  /** Absent: served only over standard input/output (`vault mcp --profile`). */
  readonly listen?: Endpoint;
  readonly token?: SecretRef;
  /** The base set, before any vault's entry. */
  readonly permissions: ReadonlySet<Permission>;
  /** Every registered vault's set: its entry applied to the base set, or the base set. */
  readonly vaults: ReadonlyMap<string, ReadonlySet<Permission>>;
  /** The owner whose approvals `accept` through this profile records. */
  readonly owner?: string;
}

export interface McpConfig {
  readonly profiles: readonly McpProfile[];
}

const WHERE = 'mcp';
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OWNER = /^\S+$/;
const HOST_PORT = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;
const ABSOLUTE_PATH = /^(\/|\\\\|[A-Za-z]:[\\/])/;

const isPermission = (name: string): name is Permission => (PERMISSIONS as readonly string[]).includes(name);

/** The permissions a name or group stands for; undefined when it is neither. */
function expand(name: string): readonly Permission[] | undefined {
  return PERMISSION_GROUPS[name] ?? (isPermission(name) ? [name] : undefined);
}

/** A plain list of names and groups, as a set. */
function readSet(r: DataReader, value: unknown, path: string): Set<Permission> {
  const set = new Set<Permission>();
  r.list(value, path).forEach((item, i) => {
    const found = typeof item === 'string' ? expand(item) : undefined;
    if (found === undefined) r.add(`${path}[${i}]`, 'is not an operation or group');
    else for (const permission of found) set.add(permission);
  });
  return set;
}

/** A vault's entry applied to the base set: groups expanded inside each edit, then the list syntax. */
function readVaultEntry(r: DataReader, base: ReadonlySet<Permission>, value: unknown, path: string): Set<Permission> {
  const items = r.list(value, path);
  const edit: string[] = [];
  items.forEach((item, i) => {
    const op = typeof item === 'string' && (item.startsWith('+') || item.startsWith('-')) ? item.slice(0, 1) : '';
    const found = typeof item === 'string' ? expand(item.slice(op.length)) : undefined;
    if (found === undefined) r.add(`${path}[${i}]`, 'is not an operation or group');
    else edit.push(...found.map((permission) => `${op}${permission}`));
  });
  if (edit.length < items.length) return new Set();
  const applied = applyListOps([...base], edit);
  if (!applied.ok) {
    r.add(path, applied.error);
    return new Set();
  }
  return new Set(applied.value as Permission[]);
}

function readEndpoint(r: DataReader, value: unknown, path: string): Endpoint | undefined {
  if (value === undefined) return undefined;
  const text = r.string(value, path);
  if (text === '') return undefined;
  if (ABSOLUTE_PATH.test(text)) return { kind: 'path', path: text };
  const found = HOST_PORT.exec(text);
  const port = Number(found?.[2]);
  if (found?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    r.add(path, 'must be host:port, or an absolute socket or pipe path');
    return undefined;
  }
  return { kind: 'tcp', host: found[1], port };
}

function readProfile(r: DataReader, value: unknown, path: string, vaultIds: ReadonlySet<string>, seen: Set<string>): McpProfile {
  const p = r.record(value, path, ['name', 'listen', 'token', 'permissions', 'vaults', 'owner']);
  const name = r.string(p['name'], issuePath(path, 'name'), PROFILE_NAME);
  if (name !== '' && seen.has(name)) r.add(issuePath(path, 'name'), 'another profile has this name');
  seen.add(name);
  const listen = readEndpoint(r, p['listen'], issuePath(path, 'listen'));
  let token: SecretRef | undefined;
  if (p['token'] !== undefined) {
    const parsed = parseSecretRef(p['token'], issuePath(path, 'token'));
    if (parsed.ok) token = parsed.value;
    else r.issues.push(parsed.error);
  } else if (listen?.kind === 'tcp') {
    r.add(path, 'an HTTP endpoint needs a token');
  }
  const permissions = p['permissions'] === undefined ? new Set<Permission>() : readSet(r, p['permissions'], issuePath(path, 'permissions'));
  const vaults = new Map<string, ReadonlySet<Permission>>([...vaultIds].map((vault) => [vault, permissions]));
  const entriesPath = issuePath(path, 'vaults');
  for (const [vault, entry] of Object.entries(r.record(p['vaults'] ?? {}, entriesPath))) {
    const where = issuePath(entriesPath, vault);
    if (!vaultIds.has(vault)) r.add(where, 'is not a registered vault');
    else vaults.set(vault, readVaultEntry(r, permissions, entry, where));
  }
  const owner = r.optionalString(p, 'owner', path, OWNER);
  const profile: McpProfile = {
    name,
    ...(listen === undefined ? {} : { listen }),
    ...(token === undefined ? {} : { token }),
    permissions,
    vaults,
    ...(owner === undefined ? {} : { owner }),
  };
  const acceptAnywhere = permissions.has('accept') || [...vaults.values()].some((set) => set.has('accept'));
  if (acceptAnywhere && owner === undefined) r.add(path, 'accept is permitted, so the profile must name an owner');
  return profile;
}

/** The `mcp` section, checked against the registered vaults. */
export function parseMcpConfig(value: unknown, vaultIds: readonly string[]): Result<McpConfig, Issue[]> {
  const r = new DataReader();
  if (value === undefined) return r.result({ profiles: [] });
  const section = r.record(value, WHERE, ['profiles']);
  const known = new Set(vaultIds);
  const seen = new Set<string>();
  const profiles = r.list(section['profiles'] ?? [], issuePath(WHERE, 'profiles'))
    .map((item, i) => readProfile(r, item, `${issuePath(WHERE, 'profiles')}[${i}]`, known, seen));
  return r.result({ profiles });
}

const NOTHING: ReadonlySet<Permission> = new Set();

/** What the profile may do in `vault`; nothing in a vault the installation does not have. */
export function effectivePermissions(profile: McpProfile, vault: string): ReadonlySet<Permission> {
  return profile.vaults.get(vault) ?? NOTHING;
}

/** Whether `operation` may be called for `vault`; `accept` only through a profile with an owner. */
export function mayCall(profile: McpProfile, operation: Permission, vault: string): boolean {
  if (operation === 'accept' && profile.owner === undefined) return false;
  return effectivePermissions(profile, vault).has(operation);
}

/** The operations a client of this profile sees: each permitted for at least one vault, in a stable order. */
export function permittedOperations(profile: McpProfile): Permission[] {
  return PERMISSIONS.filter((operation) => [...profile.vaults.keys()].some((vault) => mayCall(profile, operation, vault)));
}
