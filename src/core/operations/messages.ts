// Outcomes and messages: the one place an error value becomes the text a
// person or model reads, and a status. A refusal — a merge policy, a guard, a
// check, a hold, the unaccepted-change pause — is `refused` (exit status 3); a
// request that does not fit the operation is `invalid` (2); anything else that
// went wrong is `failed` (1).
//
// Messages say what to do next and name no secret: error values never carry
// one, and nothing here adds a value an error did not give.

import type { Issue } from '../result/index.ts';
import type { OperationOutcome } from './types.ts';

export function succeeded(text: string, data?: unknown): OperationOutcome {
  return { status: 'ok', text, ...(data === undefined ? {} : { data }) };
}

export function refused(text: string, data?: unknown): OperationOutcome {
  return { status: 'refused', text, ...(data === undefined ? {} : { data }) };
}

export function invalid(text: string, data?: unknown): OperationOutcome {
  return { status: 'invalid', text, ...(data === undefined ? {} : { data }) };
}

export function failed(text: string, data?: unknown): OperationOutcome {
  return { status: 'failed', text, ...(data === undefined ? {} : { data }) };
}

/** Reasons that are a refusal rather than a failure. */
const REFUSALS = new Set([
  'unaccepted-change', 'policy-unmet', 'checks-failed', 'not-owner', 'not-reviewed', 'branch-moved', 'actor-busy',
  'raw-address', 'unknown-recipient', 'rate-limited', 'too-large', 'unacknowledged', 'not-main-tip', 'not-permitted',
  'no-person', 'not-a-vault-actor', 'forge-mode', 'not-forge-mode', 'not-pushable', 'shadows-builtin', 'unknown-actor', 'outside-worktree',
]);

type ErrorValue = { readonly reason: string } & Record<string, unknown>;

const issueLines = (issues: unknown): string =>
  Array.isArray(issues) ? (issues as Issue[]).map((i) => `\n  ${i.path}: ${i.message}`).join('') : '';

const str = (value: unknown): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

/** What went wrong, for a person or a model to act on. */
export function describeError(error: ErrorValue): string {
  const e = error;
  switch (e.reason) {
    case 'unaccepted-change': {
      const status = e['status'] as { vault?: string; change?: string } | undefined;
      return `Vault "${status?.vault ?? ''}" has an unaccepted change to main (${status?.change ?? 'unknown'}), so this is paused until an owner resolves it.`;
    }
    case 'policy-unmet': {
      const verdict = e['verdict'] as { requirements?: { requirement: string; met: boolean; reasons: string[] }[] } | undefined;
      const unmet = (verdict?.requirements ?? []).filter((r) => !r.met).map((r) => `\n  ${r.requirement}: ${r.reasons.join('; ')}`);
      return `The merge policy is not satisfied:${unmet.join('')}`;
    }
    case 'checks-failed': {
      const results = (e['results'] as { name: string; result: string; evidence?: string }[] | undefined) ?? [];
      return `Not committed: these checks did not pass:${results.filter((r) => r.result !== 'pass').map((r) => `\n  ${r.name}: ${r.result}${r.evidence === undefined ? '' : ` — ${r.evidence}`}`).join('')}`;
    }
    case 'checks-not-recorded':
      return `Committed ${str(e['sha'])}, but the checks' verdicts could not be recorded; commit again or ask an owner to look.`;
    case 'actor-busy': {
      const hold = e['hold'] as { actor?: string; holder?: { session?: string; process?: { pid?: number } } } | undefined;
      return `Actor "${hold?.actor ?? ''}" is held by session ${hold?.holder?.session ?? '?'} (process ${hold?.holder?.process?.pid ?? '?'}); wait for it, or choose another actor.`;
    }
    case 'not-owner':
      return `"${str(e['approver'])}" is not an owner of this vault.`;
    case 'no-person':
      return 'No person is set for this installation (installation.person), and this is an owner act.';
    case 'not-reviewed':
      return `${str(e['approver'])} has not reviewed ${str(e['actor'])}'s proposal; run "vault review ${str(e['actor'])}" first.`;
    case 'branch-moved':
      return `The proposal moved since it was reviewed (reviewed ${str(e['reviewed'])}, now ${str(e['head'])}); review it again.`;
    case 'no-proposal':
      return `Actor "${str(e['actor'])}" has no proposal: its branch has nothing the accepted main does not.`;
    case 'unrelated-history':
      return `Actor "${str(e['actor'])}"'s branch shares no history with main.`;
    case 'unknown-actor':
      return `"${str(e['actor'])}" is not one of this vault's actors or owners.`;
    case 'no-accepted-main':
      return `Nothing has been accepted in vault "${str(e['vault'])}" yet; an owner can adopt main with "vault accept --adopt <sha>".`;
    case 'forge-mode':
      return 'This vault is reviewed in its forge; accept there, then "vault sync".';
    case 'not-forge-mode':
      return 'This vault is reviewed locally (vault.review is not forge).';
    case 'unacknowledged':
      return 'The concerns shown have changed or were not acknowledged; look at the delta again.';
    case 'not-main-tip':
      return `That is not main's tip (main is at ${str(e['tip'])}).`;
    case 'accepted-moved':
    case 'main-moved':
      return 'Main or the accepted main moved meanwhile; look again.';
    case 'main-not-checked-out':
      return 'No worktree has main checked out, so nothing can be merged into it.';
    case 'wrong-branch':
      return `This worktree is not on ${str(e['expected'])}.`;
    case 'worktree-mismatch':
      return `The actor's worktree directory ${str(e['path'])} holds another branch.`;
    case 'outside-worktree':
      return `The path ${str(e['path'])} is outside the actor's worktree, or inside its Git internals.`;
    case 'nothing-to-commit':
      return 'There is nothing to commit.';
    case 'dirty-worktree':
      return 'The worktree has uncommitted changes.';
    case 'conflict':
      return `The merge conflicts in: ${(e['paths'] as string[] | undefined)?.join(', ') ?? ''}; nothing was changed.`;
    case 'no-such-script':
      return `There is no script "${str(e['name'])}" on the accepted main.`;
    case 'invalid-script':
      return `Script "${str(e['name'])}" is not valid:${issueLines(e['issues'])}`;
    case 'shadows-builtin':
      return `Script "${str(e['name'])}" is named like a built-in, which it cannot replace.`;
    case 'ambiguous-script':
      return `Script "${str(e['name'])}" is defined by more than one file.`;
    case 'cannot-run':
      return `The script could not run (${str(e['detail'])}).`;
    case 'raw-address':
      return 'Notifications go only to configured aliases, never to an address.';
    case 'unknown-recipient':
      return `"${str(e['alias'])}" is not a configured recipient alias.`;
    case 'empty-subject':
      return 'The subject is empty.';
    case 'rate-limited':
      return `The hourly limit of ${str(e['perHour'])} notifications is reached.`;
    case 'delivery-failed':
      return `The transport failed: ${str(e['failure'])}.`;
    case 'not-configured':
      return `${str(e['what'])} is not configured.`;
    case 'not-found':
      return `${str(e['path']) || 'It'} was not found.`;
    case 'not-a-vault-actor':
      return `"${str(e['actor'])}" is not one of vault "${str(e['vault'])}"'s actors; through MCP, writes are made only as one of them, never as an owner.`;
    case 'not-permitted':
      return `"${str(e['operation'])}" is not permitted for vault "${str(e['vault'])}".`;
    case 'invalid':
    case 'invalid-contract':
    case 'invalid-identity':
    case 'invalid-policy':
    case 'invalid-template':
      return `Invalid:${issueLines(e['issues'])}`;
    case 'invalid-argument':
      return `Invalid ${str(e['argument'])}.`;
    case 'no-identity':
      return 'The root contract has no vault identity.';
    case 'id-mismatch':
      return `The vault is registered as "${str(e['registered'])}" but its root contract says "${str(e['declared'])}".`;
    case 'not-a-repository':
      return 'Not a Git repository.';
    case 'git-unavailable':
      return 'Git could not be run.';
    case 'unknown-revision':
      return `Unknown revision ${str(e['revision'])}.`;
    case 'ref-moved':
      return `${str(e['ref'])} moved meanwhile; try again.`;
    case 'git-failed':
      return `git ${str(e['command'])} failed${str(e['stderr']) === '' ? '' : `: ${str(e['stderr'])}`}`;
    case 'redirected':
    case 'http-error':
      return `${str(e['forge'] ?? e['role']) || 'The endpoint'} answered with status ${str(e['status'])}.`;
    case 'unreachable':
    case 'timed-out':
      return `${str(e['forge'] ?? e['role'] ?? e['command']) || 'It'} is ${e.reason === 'unreachable' ? 'unreachable' : 'not answering in time'}.`;
    case 'token':
      return `The token in ${str(e['where'])} could not be resolved.`;
    case 'no-forge':
      return `No forge is configured for host "${str(e['host'])}".`;
    case 'no-remote':
      return `The vault has no remote "${str(e['remote'])}".`;
    case 'not-a-template':
      return 'That repository is not a template (its root contract has no template key).';
    case 'unknown-template':
      return `No template is named "${str(e['name'])}".`;
    case 'not-empty':
      return `${str(e['path'])} is not empty.`;
    case 'already-registered':
      return `A vault with id "${str(e['id'])}" is already registered.`;
    case 'path-registered':
      return `That path is already registered, as vault "${str(e['id'])}".`;
    default:
      return `Failed: ${e.reason}.`;
  }
}

/** The outcome for an error value: refused or failed, with its message. */
export function fromError(error: { readonly reason: string; readonly [detail: string]: unknown }, data?: unknown): OperationOutcome {
  const text = describeError(error as ErrorValue);
  return REFUSALS.has(error.reason) ? refused(text, data ?? { error }) : failed(text, data ?? { error });
}
