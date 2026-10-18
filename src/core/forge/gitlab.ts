// GitLab's API (https://<host>/api/v4): `PRIVATE-TOKEN`, projects by their
// URL-encoded path, merge requests by `iid`, pages of `per_page`.
//
// GitLab differs in two ways that matter for the guarantees:
//  - a merge request's approvals do not say which commit they approved. They
//    are bound to its head only where the project resets approvals on push;
//    where that setting is off, or cannot be read (it is not in every tier),
//    an approval carries no commit and counts for nothing;
//  - a commit status creates an external pipeline, so `vault/policy` is
//    required when merging needs every pipeline to succeed.
//
// Squash merging is the project's `squash_option`: only `never` turns it off.
// No merge method rebases by itself; "automatic rebase prior to merge"
// (`automatic_rebase_enabled`, newer GitLab) does, for the fast-forward and
// semi-linear methods only.

import type { ForgeEntry } from '../config/index.ts';
import { isRecord, ok } from '../result/index.ts';
import {
  UNPROTECTED, anyAllowed, forgeCaller, isShaValue, onePull, readAccount, readMergeMethods, shortDescription,
  type Allowed, type ForgeAdapter, type ForgeDepsBase, type ForgeError, type PullRequest, type StatusState,
} from './adapter.ts';

const PAGE = 100;
const STATE: Readonly<Record<StatusState, string>> = { pending: 'pending', success: 'success', failure: 'failed', error: 'failed' };

/** A setting that some tiers do not offer: forbidden or absent means it cannot be read. */
const unavailable = (error: ForgeError): boolean => error.reason === 'http-error' && (error.status === 403 || error.status === 404);

/** Whether merging rebases: only with automatic rebase, which a merge commit method ignores. */
function rebasesWith(method: unknown, automatic: unknown): Allowed {
  if (method === 'merge') return false;
  return method === 'ff' || method === 'rebase_merge' ? anyAllowed(automatic) : 'unknown';
}

export function gitlabAdapter(entry: ForgeEntry, project: string, deps: ForgeDepsBase): ForgeAdapter {
  const forge = forgeCaller(entry, deps, (token) => ({ 'private-token': token }));
  const repo = `/projects/${encodeURIComponent(project)}`;

  const pullOf = (value: unknown): PullRequest | undefined => {
    if (!isRecord(value) || typeof value['iid'] !== 'number' || typeof value['source_branch'] !== 'string' || !isShaValue(value['sha'])) return undefined;
    const state = value['state'] === 'opened' ? 'open' : value['state'] === 'merged' ? 'merged' : 'closed';
    return { number: value['iid'], url: typeof value['web_url'] === 'string' ? value['web_url'] : '', head: value['source_branch'], headSha: value['sha'], state };
  };

  return {
    type: 'gitlab',
    account: () => readAccount(forge, 'username'),
    async findPullRequest(head, base) {
      const query = `state=opened&source_branch=${encodeURIComponent(head)}&target_branch=${encodeURIComponent(base)}`;
      const listed = await forge.list(`${repo}/merge_requests?${query}`, 'per_page', PAGE);
      if (!listed.ok) return listed;
      const pulls = listed.value.map(pullOf);
      if (pulls.some((p) => p === undefined)) return forge.bad('not a merge request');
      return ok(pulls.find((p) => p?.head === head));
    },
    async openPullRequest(request) {
      const made = await forge.call('POST', `${repo}/merge_requests`, {
        source_branch: request.head, target_branch: request.base, title: request.title, description: request.body,
      });
      return made.ok ? onePull(forge, pullOf, made.value.body) : made;
    },
    async updatePullRequest(number, request) {
      const updated = await forge.call('PUT', `${repo}/merge_requests/${number}`, { title: request.title, description: request.body });
      return updated.ok ? ok(undefined) : updated;
    },
    async setStatus(sha, status) {
      const set = await forge.call('POST', `${repo}/statuses/${sha}`, { name: status.context, state: STATE[status.state], description: shortDescription(status.description) });
      return set.ok ? ok(undefined) : set;
    },
    async approvals(pull) {
      const settings = await forge.call('GET', `${repo}/approvals`);
      if (!settings.ok && !unavailable(settings.error)) return settings;
      const bound = settings.ok && isRecord(settings.value.body) && settings.value.body['reset_approvals_on_push'] === true;
      const got = await forge.call('GET', `${repo}/merge_requests/${pull.number}/approvals`);
      if (!got.ok) return got;
      const by = isRecord(got.value.body) ? got.value.body['approved_by'] : undefined;
      if (!Array.isArray(by)) return forge.bad('no approvals');
      const users = by.map((a: unknown) => (isRecord(a) && isRecord(a['user']) ? a['user']['username'] : undefined));
      if (!users.every((u): u is string => typeof u === 'string')) return forge.bad('not an approval');
      return ok(users.map((user) => (bound ? { user, commit: pull.headSha } : { user })));
    },
    async protection(branch) {
      const got = await forge.call('GET', `${repo}/protected_branches/${encodeURIComponent(branch)}`);
      if (!got.ok) return got.error.reason === 'http-error' && got.error.status === 404 ? ok(UNPROTECTED) : got;
      const p = got.value.body;
      if (!isRecord(p) || !Array.isArray(p['push_access_levels'])) return forge.bad('not a protected branch');
      // Access level 0 is "no one"; any other entry, a role or a named user or group, can push.
      const directPushes = p['push_access_levels'].some((level: unknown) => !isRecord(level) || level['access_level'] !== 0);
      const settings = await forge.call('GET', repo);
      if (!settings.ok) return settings;
      const rules = await forge.call('GET', `${repo}/approval_rules`);
      if (!rules.ok && !unavailable(rules.error)) return rules;
      const required = rules.ok && Array.isArray(rules.value.body)
        ? Math.max(0, ...rules.value.body.map((r: unknown) => (isRecord(r) && typeof r['approvals_required'] === 'number' ? r['approvals_required'] : 0)))
        : 'unknown';
      return ok({
        protected: true,
        directPushes,
        forcePushes: p['allow_force_push'] === true,
        deletion: false,
        requiresPolicyStatus: isRecord(settings.value.body) && settings.value.body['only_allow_merge_if_pipeline_succeeds'] === true,
        requiredApprovals: required,
      });
    },
    mergeMethods: () => readMergeMethods(forge, repo, (s) => ({
      squash: typeof s['squash_option'] === 'string' ? s['squash_option'] !== 'never' : 'unknown',
      rebase: rebasesWith(s['merge_method'], s['automatic_rebase_enabled']),
    })),
  };
}
