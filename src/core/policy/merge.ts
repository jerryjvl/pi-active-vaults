// Evaluating merge policy for a proposal: gathering the facts, then the pure
// evaluation in `evaluate.ts`.
//
// What decides comes from the accepted `main` — the rules and axes of each
// path's effective contract, the owners, the checks and their versions — so a
// proposal cannot loosen the rules it is judged by. What is judged comes from
// the commit under review: its changes against the merge base, its content,
// and the attestations about exactly that commit and content. Any of these
// that cannot be read stops the evaluation: a policy that cannot be read
// blocks.

import { readAttestations, type Attestation, type AttestationError } from '../attestations/index.ts';
import { contractReader, type ContractError } from '../contracts/index.ts';
import { changedPaths, listTree, type FileChange, type Git, type GitError, type Sha } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { readVaultIdentity, type IdentityError } from '../registry/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { listScripts } from '../scripts/index.ts';
import { findControlChanges, type ControlChange } from './control.ts';
import { axesVersion, checkStatuses, evaluatePolicy, type CheckStatus, type PolicyChange, type PolicyInput, type PolicyVerdict } from './evaluate.ts';
import { isJudgement, parseMergeRules } from './rules.ts';

export type PolicyError =
  | GitError
  | ContractError
  | IdentityError
  | AttestationError
  | { readonly reason: 'invalid-policy'; readonly issues: readonly Issue[] };

export interface MergeRequest {
  readonly accepted: AcceptedMain;
  /** Where the proposal branched from the accepted main (their merge base). */
  readonly base: Sha;
  /** The commit under review. */
  readonly head: Sha;
  readonly tainted: boolean;
}

export interface MergeEvaluation {
  readonly verdict: PolicyVerdict;
  /** Every check on the accepted main, whether a rule requires it or not. */
  readonly checks: readonly CheckStatus[];
  readonly changes: readonly FileChange[];
  readonly control: readonly ControlChange[];
}

/** Each changed path once; a rename also leaves its old path, which is treated as deleted. */
function affectedPaths(changes: readonly FileChange[]): { path: string; deleted: boolean; of: FileChange }[] {
  return changes.flatMap((change) => [
    { path: change.path, deleted: change.change === 'deleted', of: change },
    ...(change.oldPath === undefined ? [] : [{ path: change.oldPath, deleted: true, of: change }]),
  ]);
}

export async function evaluateMerge(git: Git, repo: string, request: MergeRequest): Promise<Result<MergeEvaluation, PolicyError>> {
  const { accepted, base, head } = request;
  const changes = await changedPaths(git, repo, base, head);
  if (!changes.ok) return changes;
  const control = await findControlChanges(git, repo, base, head, changes.value);
  if (!control.ok) return control;
  const identity = await readVaultIdentity(git, repo, accepted.sha);
  if (!identity.ok) return identity;
  const checks = await listScripts(git, repo, accepted, { kind: 'check', builtins: [] });
  if (!checks.ok) return checks;
  const tree = await listTree(git, repo, head);
  if (!tree.ok) return tree;
  const commitAttestations = await readAttestations(git, repo, head);
  if (!commitAttestations.ok) return commitAttestations;

  const contentOf = new Map(tree.value.map((entry) => [entry.path, entry.sha]));
  const controlled = new Set(control.value.map((c) => c.path));
  const contracts = contractReader(git, repo, accepted.sha);
  const issues = new Map<string, Issue>();
  const policyChanges: PolicyChange[] = [];
  for (const { path, deleted, of } of affectedPaths(changes.value)) {
    const effective = await contracts.forFile(path);
    if (!effective.ok) return effective;
    const rules = parseMergeRules(effective.value.values['merge'] ?? []);
    if (!rules.ok) {
      // Name the contracts the rules came from; the same issue from many paths is reported once.
      const from = (effective.value.origins['merge'] ?? []).join(', ');
      for (const issue of rules.error) issues.set(`${from}:${issue.path}`, { path: `${from}:${issue.path}`, message: issue.message });
      continue;
    }
    const axes = (effective.value.values['axes'] ?? {}) as Record<string, unknown>;
    const content = deleted ? undefined : contentOf.get(path);
    policyChanges.push({
      path,
      deleted,
      ...(content === undefined ? {} : { content }),
      control: controlled.has(of.path),
      rules: rules.value,
      judgementVersions: Object.fromEntries(Object.entries(axes).map(([name, definition]) => [name, axesVersion(definition)])),
    });
  }
  if (issues.size > 0) return err({ reason: 'invalid-policy', issues: [...issues.values()] });

  // Content attestations are read only where some rule could ask for a judgement.
  const contentAttestations = new Map<Sha, readonly Attestation[]>();
  for (const change of policyChanges) {
    const mayNeedJudgement = change.rules.some((rule) => [...rule.require, ...rule.whenTainted].some(isJudgement));
    if (change.content === undefined || !mayNeedJudgement || contentAttestations.has(change.content)) continue;
    const read = await readAttestations(git, repo, change.content);
    if (!read.ok) return read;
    contentAttestations.set(change.content, read.value);
  }

  const input: PolicyInput = {
    subject: head,
    changes: policyChanges,
    tainted: request.tainted,
    owners: identity.value.owners,
    checks: checks.value.scripts.map((check) => ({ name: check.name, version: check.version })),
    invalidChecks: checks.value.invalid.map((check) => check.name),
    attestations: { commit: commitAttestations.value, content: contentAttestations },
  };
  return ok({ verdict: evaluatePolicy(input), checks: checkStatuses(input), changes: changes.value, control: control.value });
}
