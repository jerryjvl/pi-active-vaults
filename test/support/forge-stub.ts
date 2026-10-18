// A local stand-in for a forge's REST API — Gitea, GitHub or GitLab — over one
// shared model: pull requests, commit statuses, reviews, branch protection
// and whether squash merges are allowed. It answers in each forge's own shapes, checks the forge's own
// token header, and records every request. A pull request's head commit is
// read through `headSha`, so it can follow a real (local) remote repository.

import type { ForgeType } from '../../src/core/config/index.ts';
import { startStubServer, type RecordedRequest, type StubResponse, type StubServer } from './stub-server.ts';

export interface StubPull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
}

export interface StubReview {
  readonly pull: number;
  /** null: a deleted account (GitHub's "ghost"). */
  readonly user: string | null;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  readonly commit: string;
}

export interface ForgeModel {
  account: string;
  pulls: StubPull[];
  statuses: { sha: string; context: string; state: string; description: string }[];
  reviews: StubReview[];
  /** The forge-native protection body for `main`, or undefined when unprotected. */
  protection?: object;
  /** Whether the repository allows squash merges; undefined: the forge does not say. */
  squash?: boolean;
  /** GitHub: the active ruleset rules that apply to `main`. */
  rules?: object[];
  /** GitLab: project settings. `resetApprovalsOnPush` undefined: the setting cannot be read (Free tier). */
  gitlab: { resetApprovalsOnPush?: boolean; pipelinesMustSucceed: boolean; approvalsRequired?: number };
}

export interface ForgeStub {
  readonly server: StubServer;
  /** The API base to configure, e.g. http://127.0.0.1:1234/api/v1 */
  readonly api: string;
  readonly model: ForgeModel;
}

export const FORGE_TOKEN = 'forge-token';
const PROJECT = 'home/vault';
const BASE: Readonly<Record<ForgeType, string>> = { gitea: '/api/v1', github: '/api/v3', gitlab: '/api/v4' };

function authorised(type: ForgeType, request: RecordedRequest): boolean {
  const header = type === 'gitlab' ? request.headers['private-token'] : request.headers['authorization'];
  return header === (type === 'gitea' ? `token ${FORGE_TOKEN}` : type === 'github' ? `Bearer ${FORGE_TOKEN}` : FORGE_TOKEN);
}

function page<T>(items: readonly T[], query: URLSearchParams, sizeKey: string): T[] {
  const size = Number(query.get(sizeKey) ?? '30');
  const number = Number(query.get('page') ?? '1');
  return items.slice((number - 1) * size, number * size);
}

export async function startForgeStub(type: ForgeType, headSha: (branch: string) => string, model: Partial<ForgeModel> = {}): Promise<ForgeStub> {
  const state: ForgeModel = { account: 'vault-bot', pulls: [], statuses: [], reviews: [], gitlab: { pipelinesMustSucceed: true }, ...model };
  const base = BASE[type];

  const pullJson = (pull: StubPull): object =>
    type === 'gitlab'
      ? { iid: pull.number, web_url: `https://forge/${PROJECT}/-/merge_requests/${pull.number}`, source_branch: pull.head, target_branch: pull.base, sha: headSha(pull.head), state: pull.state === 'open' ? 'opened' : pull.state, title: pull.title, description: pull.body }
      : { number: pull.number, html_url: `https://forge/${PROJECT}/pulls/${pull.number}`, state: pull.state === 'open' ? 'open' : 'closed', merged: pull.state === 'merged', head: { ref: pull.head, sha: headSha(pull.head) }, base: { ref: pull.base }, title: pull.title, body: pull.body };

  const handle = (request: RecordedRequest): StubResponse => {
    if (!authorised(type, request)) return { status: 401, body: { message: 'bad token' } };
    const url = new URL(request.url, 'http://stub');
    if (!url.pathname.startsWith(base)) return { status: 404, body: {} };
    const path = url.pathname.slice(base.length);
    const body = request.body === '' ? {} : (JSON.parse(request.body) as Record<string, string>);
    const { method } = request;

    if (method === 'GET' && path === '/user') return { body: type === 'gitlab' ? { username: state.account } : { login: state.account } };

    const repo = type === 'gitlab' ? `/projects/${encodeURIComponent(PROJECT)}` : `/repos/${PROJECT}`;
    if (!path.startsWith(repo)) return { status: 404, body: {} };
    const rest = path.slice(repo.length);
    const pullsPath = type === 'gitlab' ? '/merge_requests' : '/pulls';

    if (method === 'GET' && rest === pullsPath) {
      const wantedState = type === 'gitlab' ? 'opened' : 'open';
      let found = state.pulls.filter((p) => (url.searchParams.get('state') === wantedState ? p.state === 'open' : true));
      if (type === 'github' && url.searchParams.has('head')) found = found.filter((p) => `home:${p.head}` === url.searchParams.get('head'));
      if (type === 'gitlab' && url.searchParams.has('source_branch')) found = found.filter((p) => p.head === url.searchParams.get('source_branch'));
      return { body: page(found, url.searchParams, type === 'gitea' ? 'limit' : 'per_page').map(pullJson) };
    }
    if (method === 'POST' && rest === pullsPath) {
      const pull: StubPull = {
        number: state.pulls.length + 1,
        head: type === 'gitlab' ? body['source_branch'] ?? '' : body['head'] ?? '',
        base: type === 'gitlab' ? body['target_branch'] ?? '' : body['base'] ?? '',
        title: body['title'] ?? '',
        body: (type === 'gitlab' ? body['description'] : body['body']) ?? '',
        state: 'open',
      };
      state.pulls.push(pull);
      return { status: 201, body: pullJson(pull) };
    }
    const one = new RegExp(`^${pullsPath}/(\\d+)(/reviews|/approvals)?$`).exec(rest);
    const pull = one === null ? undefined : state.pulls.find((p) => p.number === Number(one[1]));
    if (one !== null && pull === undefined) return { status: 404, body: {} };
    if (pull !== undefined && one?.[2] === undefined && (method === 'PATCH' || method === 'PUT')) {
      pull.title = body['title'] ?? pull.title;
      pull.body = (type === 'gitlab' ? body['description'] : body['body']) ?? pull.body;
      return { body: pullJson(pull) };
    }
    if (pull !== undefined && method === 'GET' && one?.[2] === '/reviews' && type !== 'gitlab') {
      const reviews = state.reviews.filter((r) => r.pull === pull.number).map((r) => type === 'gitea'
        ? { user: r.user === null ? null : { login: r.user }, state: r.state === 'CHANGES_REQUESTED' ? 'REQUEST_CHANGES' : r.state === 'COMMENTED' ? 'COMMENT' : r.state === 'DISMISSED' ? 'APPROVED' : r.state, commit_id: r.commit, dismissed: r.state === 'DISMISSED', stale: false }
        : { id: 1, user: r.user === null ? null : { login: r.user }, state: r.state, commit_id: r.commit, body: '' });
      return { body: page(reviews, url.searchParams, type === 'gitea' ? 'limit' : 'per_page') };
    }
    if (pull !== undefined && method === 'GET' && one?.[2] === '/approvals' && type === 'gitlab') {
      const approvers = new Set<string>();
      for (const r of state.reviews.filter((x) => x.pull === pull.number)) {
        if (r.user === null) continue;
        if (r.state === 'APPROVED') approvers.add(r.user);
        else if (r.state !== 'COMMENTED') approvers.delete(r.user);
      }
      return { body: { approved: approvers.size > 0, approved_by: [...approvers].map((username) => ({ user: { username } })) } };
    }

    const status = /^\/statuses\/([0-9a-f]{40})$/.exec(rest);
    if (method === 'POST' && status !== null) {
      state.statuses.push({ sha: status[1] ?? '', context: (type === 'gitlab' ? body['name'] : body['context']) ?? '', state: body['state'] ?? '', description: body['description'] ?? '' });
      return { status: 201, body: {} };
    }

    if (method === 'GET') {
      if (type === 'gitea' && rest === '/branch_protections/main') return state.protection === undefined ? { status: 404, body: {} } : { body: state.protection };
      if (type === 'github' && rest === '/branches/main/protection') return state.protection === undefined ? { status: 404, body: { message: 'Branch not protected' } } : { body: state.protection };
      if (type === 'github' && rest === '/rules/branches/main') return { body: page(state.rules ?? [], url.searchParams, 'per_page') };
      if (type === 'gitlab' && rest === '/protected_branches/main') return state.protection === undefined ? { status: 404, body: {} } : { body: state.protection };
      const squash = state.squash === undefined ? {} : type === 'gitlab' ? { squash_option: state.squash ? 'default_off' : 'never' } : { allow_squash_merge: state.squash };
      if (type === 'gitlab' && rest === '') return { body: { path_with_namespace: PROJECT, only_allow_merge_if_pipeline_succeeds: state.gitlab.pipelinesMustSucceed, ...squash } };
      if (type !== 'gitlab' && rest === '') return { body: { full_name: PROJECT, ...squash } };
      if (type === 'gitlab' && rest === '/approvals') {
        return state.gitlab.resetApprovalsOnPush === undefined ? { status: 403, body: {} } : { body: { reset_approvals_on_push: state.gitlab.resetApprovalsOnPush } };
      }
      if (type === 'gitlab' && rest === '/approval_rules') {
        return state.gitlab.approvalsRequired === undefined ? { status: 403, body: {} } : { body: [{ approvals_required: state.gitlab.approvalsRequired }] };
      }
    }
    return { status: 404, body: {} };
  };

  const server = await startStubServer(handle);
  return { server, api: `${server.url}${base}`, model: state };
}
