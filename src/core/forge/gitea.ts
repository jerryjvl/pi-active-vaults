// Gitea's API (https://<host>/api/v1): `Authorization: token …`, pages of
// `limit`. Reviews carry the commit they were made on, and a dismissed
// approval is marked `dismissed`. A protected branch cannot be deleted.

import type { ForgeEntry } from '../config/index.ts';
import { isRecord, ok } from '../result/index.ts';
import {
  POLICY_CONTEXT, UNPROTECTED, forgeCaller, headPull, isShaValue, onePull, readAccount, shortDescription, standingApprovals,
  type ForgeAdapter, type ForgeDepsBase,
} from './adapter.ts';

const PAGE = 50;

export function giteaAdapter(entry: ForgeEntry, project: string, deps: ForgeDepsBase): ForgeAdapter {
  const forge = forgeCaller(entry, deps, (token) => ({ authorization: `token ${token}` }));
  const repo = `/repos/${project}`;


  return {
    type: 'gitea',
    account: () => readAccount(forge, 'login'),
    async findPullRequest(head, base) {
      const listed = await forge.list(`${repo}/pulls?state=open`, 'limit', PAGE);
      if (!listed.ok) return listed;
      for (const item of listed.value) {
        const pull = headPull(item);
        if (pull === undefined) return forge.bad('not a pull request');
        if (pull.head === head && isRecord(item) && isRecord(item['base']) && item['base']['ref'] === base) return ok(pull);
      }
      return ok(undefined);
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
      const listed = await forge.list(`${repo}/pulls/${pull.number}/reviews`, 'limit', PAGE);
      if (!listed.ok) return listed;
      const reviews = [];
      for (const review of listed.value) {
        const user = isRecord(review) && isRecord(review['user']) ? review['user']['login'] : undefined;
        if (!isRecord(review) || typeof user !== 'string' || typeof review['state'] !== 'string') return forge.bad('not a review');
        const verdict = review['state'] === 'APPROVED' && review['dismissed'] !== true ? 'approve'
          : review['state'] === 'REQUEST_CHANGES' || (review['state'] === 'APPROVED' && review['dismissed'] === true) ? 'withdraw' : 'none';
        reviews.push({ user, verdict, ...(isShaValue(review['commit_id']) ? { commit: review['commit_id'] } : {}) } as const);
      }
      return ok(standingApprovals(reviews));
    },
    async protection(branch) {
      const got = await forge.call('GET', `${repo}/branch_protections/${encodeURIComponent(branch)}`);
      if (!got.ok) return got.error.reason === 'http-error' && got.error.status === 404 ? ok(UNPROTECTED) : got;
      const p = got.value.body;
      if (!isRecord(p)) return forge.bad('not a branch protection');
      const contexts = Array.isArray(p['status_check_contexts']) ? p['status_check_contexts'] : [];
      return ok({
        protected: true,
        directPushes: p['enable_push'] === true,
        forcePushes: p['enable_force_push'] === true,
        deletion: false,
        requiresPolicyStatus: p['enable_status_check'] === true && contexts.includes(POLICY_CONTEXT),
        requiredApprovals: typeof p['required_approvals'] === 'number' ? p['required_approvals'] : 0,
      });
    },
  };
}
