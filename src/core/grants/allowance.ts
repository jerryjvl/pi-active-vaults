// A job's web allowance (concepts.md "Web grants"): the `web` block of its
// frontmatter — the URLs a spawned run may fetch beyond the web broker's
// default rules, as patterns the owner reviewed. The broker does the
// matching; this module only decides whether a block is well-formed, which of
// its entries are open, and whether a host wildcard is selective enough.
//
// Invariants:
//  - parsing is strict: a block that is not exactly right is a list of
//    issues, and a job with one does not run — a malformed allowance is never
//    guessed at;
//  - an entry is carried into a grant as written (its URL pattern and its
//    placeholders' rules), so what the broker enforces is what the owner
//    reviewed, not this module's reading of it;
//  - a pattern has only the parts the broker matches: an http(s) scheme, a
//    host whose one wildcard is a leading `*.`, an optional port, a path whose
//    one wildcard is a trailing `/*`, and a query of fixed keys. User
//    information, fragments, dot segments and a wildcard anywhere else are
//    refused, so no pattern is ambiguous;
//  - an entry is open when the owner left part of it to the caller — a
//    placeholder with no rule, or a wildcard. Open entries reach scripts only,
//    unless the entry says `to: all` (`itemEntries`): a model reading
//    untrusted content is the likeliest sender of something it should not;
//  - a host wildcard must be selective (`selectivityIssues`): at least two
//    fixed labels and the configured number of characters, so `*.com.au`
//    cannot pass for "a site I trust". The broker applies its own lists of
//    capture, storage and shared-hosting suffixes on top.

import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

/** A placeholder's rule: the values it may take, or exactly a string value from a JSON response the broker returned under the same grant. */
export type PlaceholderRule = readonly string[] | 'from-response';

export interface WebEntry {
  /** The URL pattern as written. */
  readonly url: string;
  /** The rule of each placeholder that has one, by name. */
  readonly params: Readonly<Record<string, PlaceholderRule>>;
  /** Part of it is the caller's to choose: a placeholder without a rule, or a wildcard. */
  readonly open: boolean;
  /** Fan-out items may use it too (`to: all`); otherwise only scripts. */
  readonly toAll: boolean;
  /** The fixed domain under a leading `*.`, when the host has one. */
  readonly wildcardDomain?: string;
}

export interface WebAllowance {
  /** How many requests a run may make under its grant. */
  readonly requests: number;
  readonly entries: readonly WebEntry[];
}

export const WEB_LIMITS = { entries: 64, requests: 10_000, urlLength: 2000, values: 64, valueLength: 256 } as const;

const PATTERN = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
/** Fixed text in a path segment or query value: printable, and none of the characters that end or mark a part. */
const FIXED_TEXT = /^[^\s{}*#?&=/]*$/;
const QUERY_KEY = /^[A-Za-z0-9._~%-]+$/;
/** A listed value fills one segment or query value, so it carries none of the characters that would end it. */
const LISTED_VALUE = /^[^\s{}*#?&=/]+$/;
const ENTRY_KEYS = ['url', 'to'];

/** The placeholders of one segment or query value, or an issue when the text around them is not plain. */
function templateNames(r: DataReader, text: string, where: string, part: string): string[] {
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
  if (!FIXED_TEXT.test(text.replace(PLACEHOLDER, ''))) r.add(where, `has a character that is not allowed in ${part}`);
  return names;
}

interface PatternShape {
  readonly placeholders: string[];
  readonly hostWildcard?: string;
  readonly pathWildcard: boolean;
}

/** What a URL pattern holds, with an issue for every part the broker would not match exactly. */
function readPattern(r: DataReader, url: string, where: string): PatternShape {
  const shape: PatternShape = { placeholders: [], pathWildcard: false };
  if (url.length > WEB_LIMITS.urlLength) {
    r.add(where, `is longer than ${WEB_LIMITS.urlLength} characters`);
    return shape;
  }
  const m = PATTERN.exec(url);
  if (m === null) {
    r.add(where, 'must be an http or https URL pattern, without a fragment');
    return shape;
  }
  const [, , authority = '', path = '/', query] = m;
  if (authority.includes('@')) {
    r.add(where, 'must not carry user information');
    return shape;
  }
  const [host = '', port, ...extra] = authority.split(':');
  if (extra.length > 0 || (port !== undefined && !/^[1-9][0-9]{0,4}$/.test(port))) r.add(where, 'has a port that is not a number');
  const wild = host.startsWith('*.');
  const domain = wild ? host.slice(2) : host;
  if (!domain.split('.').every((label) => LABEL.test(label))) {
    r.add(where, 'must have a lowercase host name; a wildcard only as a leading "*."');
  }
  const segments = path.split('/').slice(1);
  const pathWildcard = segments.at(-1) === '*';
  const placeholders: string[] = [];
  segments.forEach((segment, i) => {
    if (segment === '*' && i === segments.length - 1) return;
    if (segment === '.' || segment === '..') r.add(where, 'must not have "." or ".." path segments');
    placeholders.push(...templateNames(r, segment, where, 'a path (a wildcard only as a trailing "/*")'));
  });
  if (query !== undefined) {
    if (pathWildcard) r.add(where, 'must not have a query after a trailing "/*", which already matches any');
    const keys = new Set<string>();
    for (const pair of query.split('&')) {
      const [key = '', value, ...rest] = pair.split('=');
      if (!QUERY_KEY.test(key) || value === undefined || rest.length > 0) {
        r.add(where, 'must have a query of key=value pairs with fixed keys');
        continue;
      }
      if (keys.has(key)) r.add(where, `has the query key "${key}" twice`);
      keys.add(key);
      placeholders.push(...templateNames(r, value, where, 'a query value'));
    }
  }
  const seen = new Set<string>();
  for (const name of placeholders) {
    if (seen.has(name)) r.add(where, `has the placeholder {${name}} twice`);
    seen.add(name);
  }
  return { placeholders, pathWildcard, ...(wild ? { hostWildcard: domain } : {}) };
}

function readRule(r: DataReader, value: unknown, where: string): PlaceholderRule {
  if (value === 'from-response') return value;
  const values = r.list(value, where);
  if (values.length === 0 || values.length > WEB_LIMITS.values) r.add(where, `must be "from-response" or a list of 1 to ${WEB_LIMITS.values} values`);
  return values.map((v, i) => {
    const text = r.string(typeof v === 'number' ? String(v) : v, `${where}[${i}]`, LISTED_VALUE);
    if (text.length > WEB_LIMITS.valueLength) r.add(`${where}[${i}]`, `is longer than ${WEB_LIMITS.valueLength} characters`);
    return text;
  });
}

function readEntry(r: DataReader, value: unknown, where: string): WebEntry {
  const e = r.record(value, where);
  const url = r.string(e['url'], issuePath(where, 'url'));
  const shape = url === '' ? { placeholders: [], pathWildcard: false } : readPattern(r, url, issuePath(where, 'url'));
  const params: Record<string, PlaceholderRule> = {};
  for (const [key, rule] of Object.entries(e)) {
    if (ENTRY_KEYS.includes(key)) continue;
    if (!shape.placeholders.includes(key)) {
      r.add(issuePath(where, key), 'is not a placeholder of the url');
      continue;
    }
    params[key] = readRule(r, rule, issuePath(where, key));
  }
  if (e['to'] !== undefined) r.oneOf(e['to'], issuePath(where, 'to'), ['all'] as const);
  const unruled = shape.placeholders.some((name) => params[name] === undefined);
  const hostWildcard = 'hostWildcard' in shape ? shape.hostWildcard : undefined;
  return {
    url, params,
    open: unruled || hostWildcard !== undefined || shape.pathWildcard,
    toAll: e['to'] === 'all',
    ...(hostWildcard === undefined ? {} : { wildcardDomain: hostWildcard }),
  };
}

/** A document's `web` block, or every issue with it. */
export function parseWebBlock(value: unknown, where = 'web'): Result<WebAllowance, Issue[]> {
  const r = new DataReader();
  const w = r.record(value, where, ['requests', 'allow']);
  if (w['requests'] === undefined) r.add(issuePath(where, 'requests'), 'is required');
  const requests = r.integer(w, 'requests', where, 1);
  if (requests > WEB_LIMITS.requests) r.add(issuePath(where, 'requests'), `must be at most ${WEB_LIMITS.requests}`);
  const allow = r.list(w['allow'], issuePath(where, 'allow'));
  if (allow.length === 0 || allow.length > WEB_LIMITS.entries) r.add(issuePath(where, 'allow'), `must list 1 to ${WEB_LIMITS.entries} entries`);
  const entries = allow.map((entry, i) => readEntry(r, entry, `${issuePath(where, 'allow')}[${i}]`));
  return r.result({ requests, entries });
}

/** An issue for every host wildcard whose fixed domain is too short or has one label: it would trust more than a site. */
export function selectivityIssues(allowance: WebAllowance, minimum: number, where = 'web'): Issue[] {
  return allowance.entries.flatMap((entry, i) => {
    const domain = entry.wildcardDomain;
    if (domain === undefined || (domain.split('.').length >= 2 && domain.length >= minimum)) return [];
    return [{
      path: `${issuePath(where, 'allow')}[${i}].url`,
      message: `a wildcard's fixed domain needs at least two labels and ${minimum} characters; name the host and open the path instead`,
    }];
  });
}

/** The entries fan-out items may use: the closed ones, and open ones marked `to: all`. */
export function itemEntries(allowance: WebAllowance): WebEntry[] {
  return allowance.entries.filter((entry) => !entry.open || entry.toAll);
}
