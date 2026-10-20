// Gitea's API (https://<host>/api/v1): `Authorization: token …`, pages of
// `limit`. Reviews carry the commit they were made on, and a dismissed
// approval is marked `dismissed`. A protected branch cannot be deleted.
// Two merge styles rebase: "Rebase, then fast-forward" (`allow_rebase`) and
// "Rebase, then create merge commit" (`allow_rebase_explicit`). A merge can be
// scheduled — `merge_when_checks_succeed`, pinned to `head_commit_id` — and
// Gitea then merges, as the account that asked, once the branch protection's
// required statuses and approvals are met: 201 scheduled, 200 merged at once,
// 409 already scheduled (or a head that moved, which cannot happen here: the
// package asks only for the head it has just found), 403 that account may not merge.

import type { ForgeEntry } from '../config/index.ts';
import { isRecord, ok } from '../result/index.ts';
import {
  POLICY_CONTEXT, UNPROTECTED, anyAllowed, forgeCaller, headPull, headPullWrites, isShaValue, mergedPulls, readAccount, readMergeMethods, standingApprovals,
  type ForgeAdapter, type ForgeDepsBase, type PullRequest, type ScheduledMerge,
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
    ...headPullWrites(forge, repo),
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
    async mergedPullRequests(base) {
      const listed = await forge.firstPage(`${repo}/pulls?state=closed&sort=recentclose&base_branch=${encodeURIComponent(base)}`, 'limit', PAGE);
      return listed.ok ? mergedPulls(forge, headPull, listed.value) : listed;
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
    mergeMethods: () => readMergeMethods(forge, repo, (s) => ({
      squash: anyAllowed(s['allow_squash_merge']),
      rebase: anyAllowed(s['allow_rebase'], s['allow_rebase_explicit']),
    })),
    ...(entry.autoMerge ? {
      async scheduleMerge(pull: PullRequest) {
        const asked = await forge.call('POST', `${repo}/pulls/${pull.number}/merge`, {
          Do: 'merge', merge_when_checks_succeed: true, head_commit_id: pull.headSha,
        });
        if (asked.ok) return ok<ScheduledMerge>(asked.value.status === 201 ? 'scheduled' : 'merged');
        if (asked.error.reason !== 'http-error') return asked;
        if (asked.error.status === 403) return ok<ScheduledMerge>('not-allowed');
        if (asked.error.status === 409) return ok<ScheduledMerge>('scheduled');
        return asked;
      },
    } : {}),
  };
}
