// GitHub's API (api.github.com, or https://<host>/api/v3 for an enterprise
// server): a bearer token, its media type and API version, pages of
// `per_page`. Reviews carry the commit they were made on; a later
// CHANGES_REQUESTED or DISMISSED review withdraws a user's approval, a
// comment does not. A branch takes pull requests only when reviews are
// required.

import type { ForgeEntry } from '../config/index.ts';
import { isRecord, ok } from '../result/index.ts';
import {
  UNPROTECTED, forgeCaller, headPull, isShaValue, onePull, readAccount, shortDescription, standingApprovals,
  type ForgeAdapter, type ForgeDepsBase,
} from './adapter.ts';

const PAGE = 100;

export function githubAdapter(entry: ForgeEntry, project: string, deps: ForgeDepsBase): ForgeAdapter {
  const forge = forgeCaller(entry, deps, (token) => ({
    authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
  }));
  const repo = `/repos/${project}`;
  const owner = project.split('/')[0] ?? '';

  const enabled = (value: unknown): boolean => isRecord(value) && value['enabled'] === true;

  return {
    type: 'github',
    account: () => readAccount(forge, 'login'),
    async findPullRequest(head, base) {
      const query = `state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${head}`)}`;
      const listed = await forge.list(`${repo}/pulls?${query}`, 'per_page', PAGE);
      if (!listed.ok) return listed;
      const pulls = listed.value.map(headPull);
      if (pulls.some((p) => p === undefined)) return forge.bad('not a pull request');
      return ok(pulls.find((p) => p?.head === head));
    },
    async openPullRequest(request) {
      const made = await forge.call('POST', `${repo}/pulls`, request);
      return made.ok ? onePull(forge, headPull, made.value.body) : made;
    },
    async updatePullRequest(number, request) {
      const updated = await forge.call('PATCH', `${repo}/pulls/${number}`, request);
      return updated.ok ? ok(undefined) : updated;
    },
    async setStatus(sha, status) {
      const set = await forge.call('POST', `${repo}/statuses/${sha}`, { context: status.context, state: status.state, description: shortDescription(status.description) });
      return set.ok ? ok(undefined) : set;
    },
    async approvals(pull) {
      const listed = await forge.list(`${repo}/pulls/${pull.number}/reviews`, 'per_page', PAGE);
      if (!listed.ok) return listed;
      const reviews = [];
      for (const review of listed.value) {
        const user = isRecord(review) && isRecord(review['user']) ? review['user']['login'] : undefined;
        if (!isRecord(review) || typeof user !== 'string' || typeof review['state'] !== 'string') return forge.bad('not a review');
        const verdict = review['state'] === 'APPROVED' ? 'approve' : review['state'] === 'CHANGES_REQUESTED' || review['state'] === 'DISMISSED' ? 'withdraw' : 'none';
        reviews.push({ user, verdict, ...(isShaValue(review['commit_id']) ? { commit: review['commit_id'] } : {}) } as const);
      }
      return ok(standingApprovals(reviews));
    },
    async protection(branch) {
      const got = await forge.call('GET', `${repo}/branches/${encodeURIComponent(branch)}/protection`);
      if (!got.ok) return got.error.reason === 'http-error' && got.error.status === 404 ? ok(UNPROTECTED) : got;
      const p = got.value.body;
      if (!isRecord(p)) return forge.bad('not a branch protection');
      const statuses = isRecord(p['required_status_checks']) ? p['required_status_checks'] : {};
      const contexts = [
        ...(Array.isArray(statuses['contexts']) ? statuses['contexts'] : []),
        ...(Array.isArray(statuses['checks']) ? statuses['checks'].map((c: unknown) => (isRecord(c) ? c['context'] : undefined)) : []),
      ];
      const reviews = isRecord(p['required_pull_request_reviews']) ? p['required_pull_request_reviews'] : undefined;
      return ok({
        protected: true,
        directPushes: reviews === undefined,
        forcePushes: enabled(p['allow_force_pushes']),
        deletion: enabled(p['allow_deletions']),
        requiresPolicyStatus: contexts.includes('vault/policy'),
        requiredApprovals: typeof reviews?.['required_approving_review_count'] === 'number' ? reviews['required_approving_review_count'] : 0,
      });
    },
  };
}
