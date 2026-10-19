// The installation config (`config.yaml`): everything that differs per machine
// or holds secrets. Loading validates the whole file and returns either a typed
// config or every problem found — a partly valid config is never applied, and
// an unconfigured model is simply absent (principle 10).
//
// Invariants: the file is strict (an unknown key is an error, so a typo cannot
// silently disable a feature); secrets stay references (see `secrets.ts`);
// error values never contain file content, because content may include a
// secret pasted by mistake. The `mcp` and `notify` sections are validated by
// the modules that own them and are passed through here as plain data.

import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { parseDuration } from '../clock/index.ts';
import { DataReader, err, issuePath as join, type Issue, type Result } from '../result/index.ts';
import { pathFor, type Host } from './platform.ts';
import { parseSecretRef, type SecretRef } from './secrets.ts';

export const MODEL_ROLES = ['judgement', 'agent', 'embed', 'rerank'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
/** The roles that speak HTTP to a configured URL; `agent` models are Pi's. */
export type EndpointRole = Exclude<ModelRole, 'agent'>;
/** Roles with at most one entry, which must be the role's default (named after it). */
const SINGLE_ENTRY_ROLES: readonly ModelRole[] = ['embed', 'rerank'];
/** A model's name: what documents and policy ask for. The role names are the defaults. */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const FORGE_TYPES = ['gitea', 'github', 'gitlab'] as const;
export type ForgeType = (typeof FORGE_TYPES)[number];

export interface ModelEndpoint {
  readonly url: string;
  readonly token: SecretRef;
  readonly model: string;
  /** Inputs per request. */
  readonly batch: number;
  /** Concurrent requests. */
  readonly parallel: number;
}

/** A configured model, by role (concepts.md "Models"). */
export type ModelEntry =
  // One member per role, so a role selects its entry type.
  | { [R in EndpointRole]: { readonly role: R } & ModelEndpoint }[EndpointRole]
  /** `model` is as Pi names it (`provider/id`); Pi holds its URL and credentials. */
  | {
    readonly role: 'agent'; readonly model: string;
    /** Concurrent item sessions of a fan-out on this model (default 1). */
    readonly parallel?: number;
    /**
     * Count a conversation's previous prompt as read from a cache when the
     * engine reports no cache reads: for engines that cache prefixes but do not
     * say so (concepts.md "Models"). Default false.
     */
    readonly assumePrefixCache?: boolean;
  };

export interface VaultEntry {
  readonly id: string;
  readonly path: string;
  readonly worktrees?: string;
  readonly host: boolean;
}

export interface ForgeEntry {
  readonly host: string;
  readonly type: ForgeType;
  readonly token: SecretRef;
  /** The API base, when it is not where the forge type usually has it. */
  readonly api?: string;
}

export interface InstallationConfig {
  /** Explicit, or `<user>@<hostname>`; the value a vault's `executor` names. */
  readonly name: string;
  readonly person?: string;
  readonly vaults: readonly VaultEntry[];
  /** By name; the entry named after a role is that role's default. */
  readonly models: Readonly<Record<string, ModelEntry>>;
  readonly forges: readonly ForgeEntry[];
  readonly labels: { readonly equivalent: readonly (readonly string[])[] };
  readonly subscriptions: readonly { readonly from: string; readonly to: string }[];
  readonly policy: readonly { readonly vaults: readonly string[]; readonly allowModels: readonly string[] }[];
  readonly budgets: {
    readonly dailyTokens?: number;
    readonly cascadePool?: number;
    readonly depthDecay: number;
    readonly maxDepth: number;
  };
  /** Tools that do not taint a session; every other tool does. */
  readonly taint: { readonly trustedTools: readonly string[] };
  readonly logs: { readonly keepDays: number };
  /** What the daemon does: how long a spawn may be queued, and how many headless sessions run at once (the agent model's capacity). */
  readonly daemon: { readonly queueTimeMs: number; readonly parallel: number };
  readonly templates: Readonly<Record<string, string>>;
  readonly mcp?: Readonly<Record<string, unknown>>;
  readonly notify?: Readonly<Record<string, unknown>>;
}

export type ConfigError =
  | { readonly reason: 'not-found'; readonly path: string }
  | { readonly reason: 'unreadable'; readonly path: string; readonly code: string }
  | { readonly reason: 'invalid-yaml'; readonly problems: readonly string[] }
  | { readonly reason: 'invalid'; readonly issues: readonly Issue[] };

const DEFAULT_DEPTH_DECAY = 0.5;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_KEEP_DAYS = 7;
const DEFAULT_QUEUE_TIME_MS = 24 * 60 * 60 * 1000;
/** A vault id, as the config and a root contract give it. */
export const VAULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORGE_HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;
const NO_WHITESPACE = /^\S+$/;

const TOP_LEVEL_KEYS = [
  'installation', 'vaults', 'models', 'forges', 'mcp', 'labels', 'subscriptions',
  'policy', 'budgets', 'taint', 'logs', 'daemon', 'notify', 'templates',
] as const;

type PlainObject = Record<string, unknown>;

/** The shared data reader, plus the two readings only the config has: host paths and secrets. */
class Reader extends DataReader {
  private readonly host: Host;

  constructor(host: Host) {
    super();
    this.host = host;
  }

  /** `~` expands to the home directory; the result must be absolute on the host's platform. */
  absolutePath(value: unknown, path: string): string {
    const text = this.string(value, path);
    if (text === '') return text;
    const p = pathFor(this.host.os);
    const expanded =
      text === '~' ? this.host.home : text.startsWith('~/') || text.startsWith('~\\')
        ? p.join(this.host.home, text.slice(2))
        : text;
    if (!p.isAbsolute(expanded)) {
      this.add(path, 'must be an absolute path (or start with ~)');
      return text;
    }
    return p.normalize(expanded);
  }

  secret(value: unknown, path: string): SecretRef {
    const parsed = parseSecretRef(value, path);
    if (parsed.ok) return parsed.value;
    this.issues.push(parsed.error);
    return { kind: 'env', name: '_INVALID_', where: path };
  }
}

/** An endpoint's URL: http or https. */
function httpUrl(r: Reader, value: unknown, path: string): string {
  const url = r.string(value, path);
  if (url === '') return url;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') r.add(path, 'must be an http or https URL');
  } catch {
    r.add(path, 'must be a valid URL');
  }
  return url;
}

const ENDPOINT_KEYS = ['url', 'token', 'model', 'batch', 'parallel'];
const AGENT_KEYS = ['model', 'parallel', 'assume-prefix-cache'];
const AGENT_MODEL = /^[^/\s]+\/\S+$/;

function readEndpoint(r: Reader, m: PlainObject, path: string): ModelEndpoint {
  return {
    url: httpUrl(r, m['url'], join(path, 'url')),
    token: r.secret(m['token'], join(path, 'token')),
    model: r.string(m['model'], join(path, 'model')),
    batch: r.integer(m, 'batch', path, 1),
    parallel: r.integer(m, 'parallel', path, 1),
  };
}

/**
 * The role of an entry: implied by a default name (a `role` that differs is
 * an error), else given. Undefined, with the issue reported, when it is neither.
 */
function readRole(r: Reader, name: string, given: unknown, path: string): ModelRole | undefined {
  const implied = MODEL_ROLES.find((role) => role === name);
  if (implied !== undefined) {
    if (given !== undefined && given !== implied) r.add(join(path, 'role'), `must be ${implied}, or left out, for the default ${implied} model`);
    return implied;
  }
  if (given === undefined) {
    r.add(join(path, 'role'), `is required for a model not named after its role (${MODEL_ROLES.join(', ')})`);
    return undefined;
  }
  return r.oneOf(given, join(path, 'role'), MODEL_ROLES);
}

function readModel(r: Reader, name: string, value: unknown, path: string): ModelEntry | undefined {
  const m = r.record(value, path, ['role', ...ENDPOINT_KEYS, 'assume-prefix-cache']);
  const role = readRole(r, name, m['role'], path);
  if (role === undefined) return undefined;
  if (role !== 'agent') {
    for (const key of Object.keys(m)) if (key !== 'role' && !ENDPOINT_KEYS.includes(key)) r.add(join(path, key), 'unknown key');
    return { role, ...readEndpoint(r, m, path) } as ModelEntry;
  }
  // Pi matches a loose `--model` pattern against whatever it knows, so only the exact provider/id is accepted:
  // the model a document's content reaches is the one the policy was given.
  for (const key of Object.keys(m)) if (key !== 'role' && !AGENT_KEYS.includes(key)) r.add(join(path, key), `an agent model carries only ${AGENT_KEYS.join(', ')}: Pi holds its URL and credentials`);
  const model = r.string(m['model'], join(path, 'model'), AGENT_MODEL);
  return { role, model, parallel: r.integer(m, 'parallel', path, 1), assumePrefixCache: r.boolean(m, 'assume-prefix-cache', path, false) };
}

function readModels(r: Reader, value: unknown): InstallationConfig['models'] {
  if (value === undefined) return {};
  const models: Record<string, ModelEntry> = {};
  for (const [name, entry] of Object.entries(r.record(value, 'models'))) {
    const path = join('models', name);
    if (!MODEL_NAME.test(name)) {
      r.add(path, 'is not a model name of letters, digits, ".", "_" or "-"');
      continue;
    }
    const model = readModel(r, name, entry, path);
    if (model !== undefined) models[name] = model;
  }
  for (const role of SINGLE_ENTRY_ROLES) {
    for (const [name, entry] of Object.entries(models)) {
      if (entry.role === role && name !== role) r.add(join('models', name), `there is only one ${role} model, and it is named ${role}`);
    }
  }
  return models;
}

function readVaults(r: Reader, value: unknown): VaultEntry[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  return r.list(value ?? [], 'vaults').map((item, i) => {
    const path = `vaults[${i}]`;
    const v = r.record(item, path, ['id', 'path', 'worktrees', 'host']);
    const id = r.string(v['id'], join(path, 'id'), VAULT_ID);
    if (id !== '' && seenIds.has(id)) r.add(join(path, 'id'), 'duplicate vault id');
    seenIds.add(id);
    const vaultPath = r.absolutePath(v['path'], join(path, 'path'));
    if (vaultPath !== '' && seenPaths.has(vaultPath)) r.add(join(path, 'path'), 'two vaults share this path');
    seenPaths.add(vaultPath);
    const worktrees = v['worktrees'] === undefined ? undefined : r.absolutePath(v['worktrees'], join(path, 'worktrees'));
    return {
      id,
      path: vaultPath,
      ...(worktrees === undefined ? {} : { worktrees }),
      host: r.boolean(v, 'host', path, false),
    };
  });
}

function readForges(r: Reader, value: unknown): ForgeEntry[] {
  const seen = new Set<string>();
  return r.list(value ?? [], 'forges').map((item, i) => {
    const path = `forges[${i}]`;
    const f = r.record(item, path, ['host', 'type', 'token', 'api']);
    const host = r.string(f['host'], join(path, 'host'), FORGE_HOST);
    if (host !== '' && seen.has(host)) r.add(join(path, 'host'), 'duplicate forge host');
    seen.add(host);
    const type = r.oneOf(f['type'], join(path, 'type'), FORGE_TYPES);
    const api = f['api'] === undefined ? undefined : httpUrl(r, f['api'], join(path, 'api'));
    return { host, type: type ?? 'gitea', token: r.secret(f['token'], join(path, 'token')), ...(api === undefined ? {} : { api }) };
  });
}

function readSubscriptionsAndPolicy(r: Reader, raw: PlainObject, vaultIds: ReadonlySet<string>) {
  const known = (id: string, path: string): void => {
    if (id !== '' && !vaultIds.has(id)) r.add(path, 'is not a registered vault');
  };
  const subscriptions = r.list(raw['subscriptions'] ?? [], 'subscriptions').map((item, i) => {
    const path = `subscriptions[${i}]`;
    const s = r.record(item, path, ['from', 'to']);
    const from = r.string(s['from'], join(path, 'from'));
    const to = r.string(s['to'], join(path, 'to'));
    known(from, join(path, 'from'));
    known(to, join(path, 'to'));
    if (from !== '' && from === to) r.add(path, 'a vault cannot subscribe to itself');
    return { from, to };
  });
  const policy = r.list(raw['policy'] ?? [], 'policy').map((item, i) => {
    const path = `policy[${i}]`;
    const p = r.record(item, path, ['vaults', 'allow-models']);
    const vaults = r.stringList(p['vaults'] ?? [], join(path, 'vaults'));
    vaults.forEach((id, j) => known(id, `${join(path, 'vaults')}[${j}]`));
    const allowModels = r.list(p['allow-models'] ?? [], join(path, 'allow-models')).map((name, j) => r.string(name, `${join(path, 'allow-models')}[${j}]`, MODEL_NAME));
    return { vaults, allowModels };
  });
  return { subscriptions, policy };
}

function readBudgets(r: Reader, value: unknown): InstallationConfig['budgets'] {
  const b = r.record(value ?? {}, 'budgets', ['daily-tokens', 'cascade-pool', 'depth-decay', 'max-depth']);
  let depthDecay = DEFAULT_DEPTH_DECAY;
  if (b['depth-decay'] !== undefined) {
    const decay = b['depth-decay'];
    if (typeof decay === 'number' && decay > 0 && decay <= 1) depthDecay = decay;
    else r.add('budgets.depth-decay', 'must be a number above 0 and at most 1');
  }
  const dailyTokens = r.integer(b, 'daily-tokens', 'budgets');
  const cascadePool = r.integer(b, 'cascade-pool', 'budgets');
  return {
    ...(dailyTokens === undefined ? {} : { dailyTokens }),
    ...(cascadePool === undefined ? {} : { cascadePool }),
    depthDecay,
    maxDepth: r.integer(b, 'max-depth', 'budgets', DEFAULT_MAX_DEPTH),
  };
}

function readDaemon(r: Reader, value: unknown): InstallationConfig['daemon'] {
  const d = r.record(value ?? {}, 'daemon', ['queue-time', 'parallel']);
  const queueTimeMs = d['queue-time'] === undefined ? DEFAULT_QUEUE_TIME_MS : parseDuration(d['queue-time']);
  if (queueTimeMs === undefined) r.add('daemon.queue-time', 'must be a duration such as 90s, 30m or 2h');
  return { queueTimeMs: queueTimeMs ?? DEFAULT_QUEUE_TIME_MS, parallel: r.integer(d, 'parallel', 'daemon', 1) };
}

function readOpaqueSection(r: Reader, raw: PlainObject, key: 'mcp' | 'notify'): PlainObject | undefined {
  return raw[key] === undefined ? undefined : r.record(raw[key], key);
}

function readTemplates(r: Reader, value: unknown): Record<string, string> {
  const section = r.record(value ?? {}, 'templates');
  return Object.fromEntries(Object.entries(section).map(([name, source]) => [name, r.string(source, `templates.${name}`)]));
}

function readLabels(r: Reader, value: unknown): InstallationConfig['labels'] {
  const l = r.record(value ?? {}, 'labels', ['equivalent']);
  const equivalent = r.list(l['equivalent'] ?? [], 'labels.equivalent').map((group, i) => {
    const path = `labels.equivalent[${i}]`;
    const labels = r.stringList(group, path);
    if (labels.length < 2) r.add(path, 'must name at least two labels');
    return labels;
  });
  return { equivalent };
}

export function parseInstallationConfig(text: string, host: Host): Result<InstallationConfig, ConfigError> {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    // Positions and codes only: the library's messages quote the offending source line.
    return err({
      reason: 'invalid-yaml',
      problems: document.errors.map((e) => `${e.code} at line ${e.linePos?.[0].line ?? '?'}`),
    });
  }
  const r = new Reader(host);
  const raw = r.record(document.toJS() ?? {}, '', TOP_LEVEL_KEYS);

  const installation = r.record(raw['installation'] ?? {}, 'installation', ['name', 'person']);
  const name = r.optionalString(installation, 'name', 'installation', NO_WHITESPACE);
  const person = r.optionalString(installation, 'person', 'installation', NO_WHITESPACE);
  const vaults = readVaults(r, raw['vaults']);
  const { subscriptions, policy } = readSubscriptionsAndPolicy(r, raw, new Set(vaults.map((v) => v.id)));
  const logs = r.record(raw['logs'] ?? {}, 'logs', ['keep-days']);
  const taint = r.record(raw['taint'] ?? {}, 'taint', ['trusted-tools']);
  const mcp = readOpaqueSection(r, raw, 'mcp');
  const notify = readOpaqueSection(r, raw, 'notify');

  const config: InstallationConfig = {
    name: name ?? `${host.user}@${host.hostname}`,
    ...(person === undefined ? {} : { person }),
    vaults,
    models: readModels(r, raw['models']),
    forges: readForges(r, raw['forges']),
    labels: readLabels(r, raw['labels']),
    subscriptions,
    policy,
    budgets: readBudgets(r, raw['budgets']),
    taint: { trustedTools: r.stringList(taint['trusted-tools'] ?? [], 'taint.trusted-tools') },
    logs: { keepDays: r.integer(logs, 'keep-days', 'logs', DEFAULT_KEEP_DAYS) },
    daemon: readDaemon(r, raw['daemon']),
    templates: readTemplates(r, raw['templates']),
    ...(mcp === undefined ? {} : { mcp }),
    ...(notify === undefined ? {} : { notify }),
  };
  const checked = r.result(config);
  return checked.ok ? checked : err({ reason: 'invalid', issues: checked.error });
}

export function loadInstallationConfig(file: string, host: Host): Result<InstallationConfig, ConfigError> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return err(code === 'ENOENT' ? { reason: 'not-found', path: file } : { reason: 'unreadable', path: file, code });
  }
  return parseInstallationConfig(text, host);
}
