// One adapter interface over the forges (core.md `forge`): what the package
// asks of Gitea, GitHub and GitLab, in the package's own terms. Each forge's
// API shapes live in its own file; what they share — the API base, the token,
// requests through `http`, paging, reading answers — lives here.
//
// Invariants:
//  - requests go through `http`, so a redirect is an error and the token is
//    never resent elsewhere; the token is resolved once per adapter, when
//    first needed, and appears in no error;
//  - every answer is read in full against the shape expected; anything else is
//    an error, never a guess;
//  - an approval carries the exact commit it approved, or no commit when the
//    forge cannot say — and then counts for nothing;
//  - lists are read page by page up to a bound; a longer list is an error
//    rather than a silently shortened answer. Only "most recent" questions
//    read a first page alone, by design.

import { resolveSecret, type ForgeEntry, type SecretDeps } from '../config/index.ts';
import { isSha, type Sha } from '../git/index.ts';
import { requestJson, type HttpClient, type HttpError, type HttpRequest } from '../http/index.ts';
import { err, isRecord, ok, type Result } from '../result/index.ts';

export interface PullRequest {
  readonly number: number;
  readonly url: string;
  /** The branch proposed. */
  readonly head: string;
  readonly headSha: Sha;
  readonly state: 'open' | 'closed' | 'merged';
}

export type StatusState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatus {
  readonly context: string;
  readonly state: StatusState;
  readonly description: string;
}

/** A user's standing approval; `commit` absent when the forge cannot say which commit it was for. */
export interface ForgeApproval {
  readonly user: string;
  readonly commit?: Sha;
}

/** What `main`'s protection allows, as `vault doctor` checks it (security-setup.md). */
export interface BranchProtection {
  readonly protected: boolean;
  /** Commits can be pushed to it directly, not only merged through a pull request. */
  readonly directPushes: boolean;
  readonly forcePushes: boolean;
  readonly deletion: boolean;
  /** Merging requires `vault/policy` (GitLab: every pipeline, statuses included, to succeed). */
  readonly requiresPolicyStatus: boolean;
  readonly requiredApprovals: number | 'unknown';
}

export const UNPROTECTED: BranchProtection = {
  protected: false, directPushes: true, forcePushes: true, deletion: true, requiresPolicyStatus: false, requiredApprovals: 0,
};

export type ForgeError =
  | { readonly reason: 'token'; readonly forge: string; readonly where: string }
  | (HttpError & { readonly forge: string })
  | { readonly reason: 'no-forge'; readonly host: string };

export interface ForgeAdapter {
  readonly type: ForgeEntry['type'];
  /** The account the package acts as: the executor's. */
  account(): Promise<Result<string, ForgeError>>;
  findPullRequest(head: string, base: string): Promise<Result<PullRequest | undefined, ForgeError>>;
  openPullRequest(request: { head: string; base: string; title: string; body: string }): Promise<Result<PullRequest, ForgeError>>;
  updatePullRequest(number: number, request: { title: string; body: string }): Promise<Result<void, ForgeError>>;
  setStatus(sha: Sha, status: CommitStatus): Promise<Result<void, ForgeError>>;
  approvals(pull: PullRequest): Promise<Result<ForgeApproval[], ForgeError>>;
  /** The pull requests merged into `base` most recently, newest first: one page. Each `headSha` is the head it was merged at. */
  mergedPullRequests(base: string): Promise<Result<PullRequest[], ForgeError>>;
  protection(branch: string): Promise<Result<BranchProtection, ForgeError>>;
  /** Which merge methods that replace a proposal's commits the repository allows. */
  mergeMethods(): Promise<Result<MergeMethods, ForgeError>>;
}

/** Allowed or not; `unknown` when the forge does not say (it may need more access). */
export type Allowed = boolean | 'unknown';

/**
 * The merge methods that replace a proposal's commits with new ones — a squash
 * with one commit, a rebase with copies — so the trailers survive at most,
 * while the attestations and trace notes on the reviewed commits do not
 * reach `main`. Merge commits and fast-forwards keep the commits.
 */
export interface MergeMethods {
  readonly squash: Allowed;
  readonly rebase: Allowed;
}

/** Any of `flags` true allows it; all false forbids it; otherwise the forge does not say. */
export function anyAllowed(...flags: readonly unknown[]): Allowed {
  if (flags.some((f) => f === true)) return true;
  return flags.every((f) => f === false) ? false : 'unknown';
}

export interface ForgeDepsBase {
  readonly client: HttpClient;
  readonly secrets: SecretDeps;
}

/** The forge's API base: configured, or where the forge type has it. */
function apiBase(entry: ForgeEntry): string {
  if (entry.api !== undefined) return entry.api.replace(/\/+$/, '');
  switch (entry.type) {
    case 'gitea':
      return `https://${entry.host}/api/v1`;
    case 'github':
      return entry.host === 'github.com' ? 'https://api.github.com' : `https://${entry.host}/api/v3`;
    case 'gitlab':
      return `https://${entry.host}/api/v4`;
  }
}

/** The status that carries the vault's merge policy to the forge, and that `main`'s protection must require. */
export const POLICY_CONTEXT = 'vault/policy';

// Forges cap a status description; GitHub documents it only as "short".
// 140 characters keeps it short everywhere.
const MAX_DESCRIPTION = 140;
const MAX_PAGES = 20;

export function shortDescription(text: string): string {
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}

export const isShaValue = (value: unknown): value is Sha => typeof value === 'string' && isSha(value);

/** Requests to one forge: its base, its token header, its errors. */
export interface ForgeCaller {
  readonly forge: string;
  call(method: HttpRequest['method'], path: string, body?: unknown): Promise<Result<{ status: number; body: unknown }, ForgeError>>;
  /** GET a list across pages of `size`, with the forge's own page-size parameter. */
  list(path: string, sizeParameter: string, size: number): Promise<Result<unknown[], ForgeError>>;
  /** GET only the first page of a list: for questions about what is most recent. */
  firstPage(path: string, sizeParameter: string, size: number): Promise<Result<unknown[], ForgeError>>;
  bad(detail: string): Result<never, ForgeError>;
}

export function forgeCaller(entry: ForgeEntry, deps: ForgeDepsBase, headers: (token: string) => Record<string, string>): ForgeCaller {
  const base = apiBase(entry);
  const forge = entry.host;
  let token: Promise<Result<string, ForgeError>> | undefined;
  const tokenOnce = (): Promise<Result<string, ForgeError>> => {
    token ??= resolveSecret(entry.token, deps.secrets).then((resolved) =>
      resolved.ok ? resolved : err({ reason: 'token', forge, where: resolved.error.where }));
    return token;
  };
  const bad = (detail: string): Result<never, ForgeError> => err({ reason: 'bad-response', detail, forge });

  const call: ForgeCaller['call'] = async (method, path, body) => {
    const resolved = await tokenOnce();
    if (!resolved.ok) return resolved;
    const sent = await requestJson(deps.client, { method, url: `${base}${path}`, headers: headers(resolved.value), ...(body === undefined ? {} : { body }) });
    return sent.ok ? ok(sent.value) : err({ ...sent.error, forge });
  };

  const page = async (path: string, sizeParameter: string, size: number, number: number): Promise<Result<unknown[], ForgeError>> => {
    const got = await call('GET', `${path}${path.includes('?') ? '&' : '?'}${sizeParameter}=${size}&page=${number}`);
    if (!got.ok) return got;
    return Array.isArray(got.value.body) ? ok(got.value.body) : bad('expected a list');
  };

  const list: ForgeCaller['list'] = async (path, sizeParameter, size) => {
    const items: unknown[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const got = await page(path, sizeParameter, size, number);
      if (!got.ok) return got;
      items.push(...got.value);
      if (got.value.length < size) return ok(items);
    }
    return bad('more pages than the package reads');
  };

  const firstPage: ForgeCaller['firstPage'] = (path, sizeParameter, size) => page(path, sizeParameter, size, 1);

  return { forge, call, list, firstPage, bad };
}

/** The account a forge's `/user` answer names, in its `field`. */
export async function readAccount(forge: ForgeCaller, field: 'login' | 'username'): Promise<Result<string, ForgeError>> {
  const got = await forge.call('GET', '/user');
  if (!got.ok) return got;
  const name = isRecord(got.value.body) ? got.value.body[field] : undefined;
  return typeof name === 'string' ? ok(name) : forge.bad(`no ${field}`);
}

/** A pull request as Gitea and GitHub both give it: `number`, `html_url`, `head.ref` and `head.sha`. */
export function headPull(value: unknown): PullRequest | undefined {
  if (!isRecord(value) || typeof value['number'] !== 'number' || !isRecord(value['head'])) return undefined;
  const { ref, sha } = value['head'];
  if (typeof ref !== 'string' || !isShaValue(sha)) return undefined;
  const merged = value['merged'] === true || typeof value['merged_at'] === 'string';
  return { number: value['number'], url: typeof value['html_url'] === 'string' ? value['html_url'] : '', head: ref, headSha: sha, state: merged ? 'merged' : value['state'] === 'open' ? 'open' : 'closed' };
}

/** The merged ones among listed pull requests read with `pullOf`, or a bad response. */
export function mergedPulls(forge: ForgeCaller, pullOf: (value: unknown) => PullRequest | undefined, listed: readonly unknown[]): Result<PullRequest[], ForgeError> {
  const pulls = listed.map(pullOf);
  if (pulls.some((p) => p === undefined)) return forge.bad('not a pull request');
  return ok((pulls as PullRequest[]).filter((p) => p.state === 'merged'));
}

/** One pull request read with `pullOf`, or a bad response. */
export function onePull(forge: ForgeCaller, pullOf: (value: unknown) => PullRequest | undefined, value: unknown): Result<PullRequest, ForgeError> {
  const pull = pullOf(value);
  return pull === undefined ? forge.bad('not a pull request') : ok(pull);
}

/** Each user's standing approval from reviews in order: an approval stands until changes are requested or it is dismissed. */
export function standingApprovals(reviews: readonly { user: string; verdict: 'approve' | 'withdraw' | 'none'; commit?: Sha }[]): ForgeApproval[] {
  const standing = new Map<string, ForgeApproval>();
  for (const review of reviews) {
    if (review.verdict === 'approve') standing.set(review.user, { user: review.user, ...(review.commit === undefined ? {} : { commit: review.commit }) });
    else if (review.verdict === 'withdraw') standing.delete(review.user);
  }
  return [...standing.values()];
}

/** The repository's settings (`GET repo`), read through `methods`; a field the forge leaves out is `unknown`. */
export async function readMergeMethods(forge: ForgeCaller, repo: string, methods: (settings: Record<string, unknown>) => MergeMethods): Promise<Result<MergeMethods, ForgeError>> {
  const got = await forge.call('GET', repo);
  if (!got.ok) return got;
  return isRecord(got.value.body) ? ok(methods(got.value.body)) : forge.bad('not a repository');
}

export type ProtectionProblem =
  | 'not-protected' | 'direct-pushes' | 'force-pushes' | 'deletion' | 'policy-status-not-required'
  | 'approval-not-required' | 'approval-unknown' | 'squash-merges' | 'rebase-merges' | 'merges-unknown' | 'executor-is-owner';

/** What `vault doctor` knows about the repository beyond `main`'s protection. */
export interface ForgeSettings {
  /** The executor's account. */
  readonly account: string;
  readonly owners: readonly string[];
  readonly merges: MergeMethods;
}

/**
 * How `main`'s protection, the repository's merge methods and the executor's
 * account fall short of the recommended setup (security-setup.md), for
 * `vault doctor`. Owner approval not being required is reported, not
 * refused: a vault may deliberately let `vault/policy` alone decide. Squash
 * and rebase merges must be off (`MergeMethods`); what the forge does not
 * say is `merges-unknown`.
 */
export function protectionProblems(protection: BranchProtection, who: ForgeSettings): ProtectionProblem[] {
  const problems: ProtectionProblem[] = [];
  if (!protection.protected) problems.push('not-protected');
  else {
    if (protection.directPushes) problems.push('direct-pushes');
    if (protection.forcePushes) problems.push('force-pushes');
    if (protection.deletion) problems.push('deletion');
    if (!protection.requiresPolicyStatus) problems.push('policy-status-not-required');
    if (protection.requiredApprovals === 'unknown') problems.push('approval-unknown');
    else if (protection.requiredApprovals < 1) problems.push('approval-not-required');
  }
  if (who.merges.squash === true) problems.push('squash-merges');
  if (who.merges.rebase === true) problems.push('rebase-merges');
  if (who.merges.squash === 'unknown' || who.merges.rebase === 'unknown') problems.push('merges-unknown');
  if (who.owners.includes(who.account)) problems.push('executor-is-owner');
  return problems;
}
