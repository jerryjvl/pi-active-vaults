// GitHub's API (api.github.com, or https://<host>/api/v3 for an enterprise
// server), as its REST description gives it: a bearer token, its media type
// and API version 2022-11-28, pages of `per_page` (at most 100) and `page`.
// Reviews come in chronological order and carry the commit they were made
// on; a later CHANGES_REQUESTED or DISMISSED review withdraws a user's
// approval, a comment does not. A review's user is null for a deleted account
// and its commit null for a commit no longer in Git; either counts for nothing.
//
// What protects a branch comes from two places, and both are read: branch
// protection (404 when there is none) and the active rules of every ruleset
// that applies to the branch, at repository or organisation level. A
// restriction from either holds; the most approvals either requires is
// required. GitHub also answers 404 to a token that may not read branch
// protection, so what cannot be read is reported missing, never assumed. A branch takes changes only through pull requests when reviews
// are required or a `pull_request` rule applies.

import type { ForgeEntry } from '../config/index.ts';
import { isRecord, ok, type Result } from '../result/index.ts';
import {
  POLICY_CONTEXT, UNPROTECTED, anyAllowed, forgeCaller, headPull, isShaValue, mergedPulls, onePull, readAccount, readMergeMethods, shortDescription, standingApprovals,
  type ForgeAdapter, type ForgeDepsBase, type ForgeError,
} from './adapter.ts';

const PAGE = 100;

/** What one source of protection restricts on a branch. */
interface Restrictions {
  pullRequestsOnly: boolean;
  noForcePushes: boolean;
  noDeletion: boolean;
  statuses: string[];
  approvals: number;
}

export function githubAdapter(entry: ForgeEntry, project: string, deps: ForgeDepsBase): ForgeAdapter {
  const forge = forgeCaller(entry, deps, (token) => ({
    authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
  }));
  const repo = `/repos/${project}`;
  const owner = project.split('/')[0] ?? '';

  const enabled = (value: unknown): boolean => isRecord(value) && value['enabled'] === true;

  /** Branch protection in the package's terms, or undefined when there is none. */
  const classicProtection = async (branch: string): Promise<Result<Restrictions | undefined, ForgeError>> => {
    const got = await forge.call('GET', `${repo}/branches/${encodeURIComponent(branch)}/protection`);
    if (!got.ok) return got.error.reason === 'http-error' && got.error.status === 404 ? ok(undefined) : got;
    const p = got.value.body;
    if (!isRecord(p)) return forge.bad('not a branch protection');
    const statuses = isRecord(p['required_status_checks']) ? p['required_status_checks'] : {};
    const contexts = [
      ...(Array.isArray(statuses['contexts']) ? statuses['contexts'] : []),
      ...(Array.isArray(statuses['checks']) ? statuses['checks'].map((c: unknown) => (isRecord(c) ? c['context'] : undefined)) : []),
    ];
    const reviews = isRecord(p['required_pull_request_reviews']) ? p['required_pull_request_reviews'] : undefined;
    return ok({
      pullRequestsOnly: reviews !== undefined,
      noForcePushes: !enabled(p['allow_force_pushes']),
      noDeletion: !enabled(p['allow_deletions']),
      statuses: contexts.filter((c): c is string => typeof c === 'string'),
      approvals: typeof reviews?.['required_approving_review_count'] === 'number' ? reviews['required_approving_review_count'] : 0,
    });
  };

  /** The active ruleset rules for the branch, in the package's terms, or undefined when none apply. */
  const rulesetRestrictions = async (branch: string): Promise<Result<Restrictions | undefined, ForgeError>> => {
    const listed = await forge.list(`${repo}/rules/branches/${encodeURIComponent(branch)}`, 'per_page', PAGE);
    if (!listed.ok) return listed;
    if (listed.value.length === 0) return ok(undefined);
    const found: Restrictions = { pullRequestsOnly: false, noForcePushes: false, noDeletion: false, statuses: [], approvals: 0 };
    for (const rule of listed.value) {
      if (!isRecord(rule) || typeof rule['type'] !== 'string') return forge.bad('not a ruleset rule');
      const parameters = isRecord(rule['parameters']) ? rule['parameters'] : {};
      switch (rule['type']) {
        case 'deletion':
          found.noDeletion = true;
          break;
        case 'non_fast_forward':
          found.noForcePushes = true;
          break;
        case 'pull_request': {
          const count = parameters['required_approving_review_count'];
          if (typeof count !== 'number') return forge.bad('not a pull_request rule');
          found.pullRequestsOnly = true;
          found.approvals = Math.max(found.approvals, count);
          break;
        }
        case 'required_status_checks': {
          const checks = parameters['required_status_checks'];
          if (!Array.isArray(checks) || !checks.every((c) => isRecord(c) && typeof c['context'] === 'string')) return forge.bad('not a required_status_checks rule');
          found.statuses.push(...checks.map((c) => (c as { context: string }).context));
          break;
        }
        default:
          break; // rules about commits, files or names do not bear on who can change main
      }
    }
    return ok(found);
  };

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
        if (!isRecord(review) || typeof review['state'] !== 'string') return forge.bad('not a review');
        if (review['user'] === null) continue; // a deleted account approves nothing
        const user = isRecord(review['user']) ? review['user']['login'] : undefined;
        if (typeof user !== 'string') return forge.bad('not a review');
        const verdict = review['state'] === 'APPROVED' ? 'approve' : review['state'] === 'CHANGES_REQUESTED' || review['state'] === 'DISMISSED' ? 'withdraw' : 'none';
        reviews.push({ user, verdict, ...(isShaValue(review['commit_id']) ? { commit: review['commit_id'] } : {}) } as const);
      }
      return ok(standingApprovals(reviews));
    },
    async mergedPullRequests(base) {
      // A list says a pull request was merged only by `merged_at` (`headPull` reads both).
      const listed = await forge.firstPage(`${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc`, 'per_page', PAGE);
      return listed.ok ? mergedPulls(forge, headPull, listed.value) : listed;
    },
    async protection(branch) {
      const classic = await classicProtection(branch);
      if (!classic.ok) return classic;
      const rules = await rulesetRestrictions(branch);
      if (!rules.ok) return rules;
      const sources = [classic.value, rules.value].filter((r): r is Restrictions => r !== undefined);
      if (sources.length === 0) return ok(UNPROTECTED);
      return ok({
        protected: true,
        directPushes: !sources.some((r) => r.pullRequestsOnly),
        forcePushes: !sources.some((r) => r.noForcePushes),
        deletion: !sources.some((r) => r.noDeletion),
        requiresPolicyStatus: sources.some((r) => r.statuses.includes(POLICY_CONTEXT)),
        requiredApprovals: Math.max(...sources.map((r) => r.approvals)),
      });
    },
    // The merge settings are shown only to a token with contents read and write.
    mergeMethods: () => readMergeMethods(forge, repo, (s) => ({
      squash: anyAllowed(s['allow_squash_merge']),
      rebase: anyAllowed(s['allow_rebase_merge']),
    })),
  };
}
