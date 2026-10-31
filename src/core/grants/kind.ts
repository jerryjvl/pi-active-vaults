// Web grants as a kind of statement the signer makes (components/signer.md,
// concepts.md "Web grants"): whether to sign a run's grants, and what they say.
//
// Invariants:
//  - a request names only a vault, a job and a run's trace. The allowance is
//    read from the job's `web` block on the vault's `main` as the signer
//    fetches it itself (signing module) — never from the request — so whoever
//    asks gets only what an owner reviewed;
//  - a job holds at most one unexpired grant: a second request while one is
//    live is refused, so a session that asks first can deny its run a grant
//    (the run then fetches under the broker's default rules) but never widen
//    one. The record is kept in the signer's store, so a restart forgets
//    nothing;
//  - a grant expires its job's run time plus a minute after it is issued;
//  - a wildcard that is not selective enough for the signer's minimum is no
//    grant at all, not a grant without that entry.

import { parseBudget } from '../budgets/index.ts';
import type { SignerConfig } from '../config/index.ts';
import { readDocumentAt } from '../documents/index.ts';
import { listTree, type Sha } from '../git/index.ts';
import { isTraceId } from '../ids/index.ts';
import { DataReader, err, ok, type Issue, type Result } from '../result/index.ts';
import { fetchSignerMain, type SignRefusal, type SignerDeps, type StatementKind } from '../signing/index.ts';
import type { ModuleSchema } from '../store/index.ts';
import { itemEntries, parseWebBlock, selectivityIssues, type WebEntry } from './allowance.ts';
import { signGrant, type GrantClaims } from './token.ts';

/** The name a signing request asks for web grants by. */
export const WEB_GRANT_KIND = 'web-grant';
/** How long past its run time a grant stays valid. */
const GRACE_MS = 60_000;

export const grantsSchema: ModuleSchema = {
  module: 'grants',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE grants_issued (
        vault TEXT NOT NULL,
        job TEXT NOT NULL,
        trace TEXT NOT NULL,
        issued TEXT NOT NULL,
        expires TEXT NOT NULL,
        PRIMARY KEY (vault, job, trace)
      ) STRICT`,
    },
  ],
};

export interface GrantRequest {
  readonly vault: string;
  readonly job: string;
  readonly trace: string;
}

/** A run's grants: one for its scripts, and one for its fan-out items when any entry is theirs. */
export interface IssuedGrants {
  readonly script: string;
  readonly item?: string;
  /** When they expire (ISO 8601). */
  readonly expires: string;
  /** The commit of `main` and the job's blob they were signed from. */
  readonly main: Sha;
  readonly blob: Sha;
}

const JOB_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\\]+\.md$/;

/** A request's fields, exactly: a vault ID, a job's path and a trace ID, and nothing else. */
export function parseGrantRequest(params: unknown): Result<GrantRequest, Issue[]> {
  const r = new DataReader();
  const p = r.record(params, 'params', ['vault', 'job', 'trace']);
  const vault = r.string(p['vault'], 'vault');
  const job = r.string(p['job'], 'job', JOB_PATH);
  const trace = r.string(p['trace'], 'trace');
  if (trace !== '' && !isTraceId(trace)) r.add('trace', 'is not a trace ID');
  return r.result({ vault, job, trace });
}

const issueText = (list: readonly Issue[]): string => list.map((i) => `${i.path}: ${i.message}`).join('; ');
const refuse = (reason: string, text: string): Result<never, SignRefusal> => err({ reason, text });

const allowOf = (entries: readonly WebEntry[]): GrantClaims['allow'] =>
  entries.map((e) => (Object.keys(e.params).length === 0 ? { url: e.url } : { url: e.url, params: e.params }));

/** The kind of statement that is a run's web grants, as this signer configuration makes them. */
export function webGrantKind(deps: SignerDeps, config: SignerConfig): StatementKind {
  const { wildcardMin } = config.webGrant;
  return {
    name: WEB_GRANT_KIND,
    status: { wildcardMin },
    async sign(params, key) {
      const request = parseGrantRequest(params);
      if (!request.ok) return refuse('invalid-request', `the request is not valid (${issueText(request.error)})`);
      const { job, trace } = request.value;
      const vault = config.vaults.find((v) => v.id === request.value.vault);
      if (vault === undefined) return refuse('unknown-vault', `the signer does not sign for "${request.value.vault}"`);
      const fetched = await fetchSignerMain(deps, vault);
      if (!fetched.ok) return fetched;
      const { repo, main } = fetched.value;
      const read = await readDocumentAt(deps.git, repo, main, job);
      if (!read.ok || read.value.state === 'missing') return refuse('no-such-job', `${job} is not on the vault's main`);
      if (read.value.state === 'unreadable') return refuse('unreadable-job', `${job}'s frontmatter cannot be read`);
      const { frontmatter } = read.value.document;
      if (frontmatter['web'] === undefined) return refuse('no-web-block', `${job} has no web block on the vault's main`);
      const allowance = parseWebBlock(frontmatter['web']);
      if (!allowance.ok) return refuse('invalid-web-block', `${job}'s web block is not valid (${issueText(allowance.error)})`);
      const open = selectivityIssues(allowance.value, wildcardMin);
      if (open.length > 0) return refuse('too-open', `${job}'s web block has a wildcard that is too open (${issueText(open)})`);
      const budget = parseBudget(frontmatter['budget']);
      if (!budget.ok) return refuse('no-budget', `${job} has no readable budget (${issueText(budget.error)})`);
      const entry = await listTree(deps.git, repo, main, job);
      const blob = entry.ok ? entry.value.find((e) => e.path === job)?.sha : undefined;
      if (blob === undefined) return refuse('no-such-job', `${job} is not on the vault's main`);

      const now = deps.clock.now();
      const expires = new Date(now.getTime() + budget.value.ttlMs + GRACE_MS);
      const base = {
        iss: deps.issuer, jti: trace, iat: Math.floor(now.getTime() / 1000), exp: Math.floor(expires.getTime() / 1000),
        vault: vault.id, job, blob, main, requests: allowance.value.requests,
      };
      const tooLarge = (bytes: number): Result<never, SignRefusal> => refuse('too-large', `the grant would be ${bytes} bytes, more than a grant may be`);
      const script = signGrant({ ...base, aud: 'script', allow: allowOf(allowance.value.entries) }, key);
      if (!script.ok) return tooLarge(script.error.bytes);
      const items = itemEntries(allowance.value);
      const item = items.length === 0 ? undefined : signGrant({ ...base, aud: 'item', allow: allowOf(items) }, key);
      if (item?.ok === false) return tooLarge(item.error.bytes);

      // Recorded only once both are signed; checked and recorded in one transaction, so two requests cannot both pass.
      const at = now.toISOString();
      const live = deps.store.transaction((tx) => {
        tx.run('DELETE FROM grants_issued WHERE expires <= ?', [at]);
        const held = tx.get<{ expires: string }>('SELECT expires FROM grants_issued WHERE vault = ? AND job = ?', [vault.id, job]);
        if (held !== undefined) return held.expires;
        tx.run('INSERT INTO grants_issued (vault, job, trace, issued, expires) VALUES (?, ?, ?, ?, ?)', [vault.id, job, trace, at, expires.toISOString()]);
        return undefined;
      });
      if (live !== undefined) return refuse('grant-live', `${job} already holds a grant, until ${live}`);
      const issued: IssuedGrants = { script: script.value, ...(item === undefined ? {} : { item: item.value }), expires: expires.toISOString(), main, blob };
      return ok(issued);
    },
  };
}
