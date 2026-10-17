// Evaluating merge policy: a pure function from the facts about a proposal to
// a verdict per requirement (concepts.md "Merge policy").
//
// Every changed path needs the requirements of every rule whose globs match
// it, plus `when-tainted` ones for a tainted proposal, plus `owner` for a
// control change — the floor no contract can lower. A deleted path cannot be
// judged, so its judgement requirements become `owner`: a gate that cannot
// reach a verdict routes to a person. A requirement is met only by a passing
// attestation that is current: for this exact commit, at the check's version
// on the accepted `main`, or for this exact content under the axes now in
// effect. Anything missing, failed, stale or unusable leaves it unmet.

import { createHash } from 'node:crypto';
import { latestAttestation, type Attestation } from '../attestations/index.ts';
import { matchesGlob } from '../conditions/index.ts';
import type { Sha } from '../git/index.ts';
import { isJudgement, judgementName, type MergeRule, type Requirement } from './rules.ts';

/** One changed path, with what the accepted main says about it. */
export interface PolicyChange {
  readonly path: string;
  /** Deleted, or the old path of a rename. */
  readonly deleted: boolean;
  /** Its blob SHA in the commit under review (absent when deleted). */
  readonly content?: Sha;
  readonly control: boolean;
  /** The merge rules of the path's effective contract. */
  readonly rules: readonly MergeRule[];
  /** The version of each judgement (axis) in effect for the path. */
  readonly judgementVersions: Readonly<Record<string, string>>;
}

export interface PolicyInput {
  /** The commit under review. */
  readonly subject: Sha;
  readonly changes: readonly PolicyChange[];
  readonly tainted: boolean;
  readonly owners: readonly string[];
  /** The checks on the accepted main, with their versions. */
  readonly checks: readonly { readonly name: string; readonly version: Sha }[];
  /** Checks on the accepted main that cannot run, so cannot pass. */
  readonly invalidChecks: readonly string[];
  readonly attestations: {
    /** About the commit under review. */
    readonly commit: readonly Attestation[];
    /** About content, by blob SHA. */
    readonly content: ReadonlyMap<Sha, readonly Attestation[]>;
  };
}

export interface RequirementVerdict {
  readonly requirement: Requirement;
  /** The paths that need it, sorted. */
  readonly paths: readonly string[];
  readonly met: boolean;
  /** Why it is unmet. */
  readonly reasons: readonly string[];
}

export interface PolicyVerdict {
  readonly satisfied: boolean;
  /** Each requirement once: `checks`, `owner`, then judgements by name. */
  readonly requirements: readonly RequirementVerdict[];
}

/** A judgement's version: a hash of its axis definition, independent of key order. */
export function axesVersion(definition: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  return createHash('sha256').update(JSON.stringify(canonical(definition))).digest('hex');
}

/** What one path needs. */
export function requirementsFor(change: PolicyChange, tainted: boolean): Set<Requirement> {
  const needed = new Set<Requirement>();
  for (const rule of change.rules) {
    if (!rule.paths.some((glob) => matchesGlob(change.path, glob))) continue;
    for (const requirement of [...rule.require, ...(tainted ? rule.whenTainted : [])]) {
      needed.add(change.deleted && isJudgement(requirement) ? 'owner' : requirement);
    }
  }
  if (change.control) needed.add('owner');
  return needed;
}

export interface CheckStatus {
  readonly name: string;
  /**
   * `missing` (no result for this commit), `stale` (a result from another
   * version of the check), `unusable` (the check cannot run), or the result
   * itself: `pass`, `fail` or a named outcome.
   */
  readonly status: string;
}

/** Where each check on the accepted main stands for the commit under review, by name. */
export function checkStatuses(input: Pick<PolicyInput, 'subject' | 'checks' | 'invalidChecks' | 'attestations'>): CheckStatus[] {
  const statuses: CheckStatus[] = input.invalidChecks.map((name) => ({ name, status: 'unusable' }));
  for (const { name, version } of input.checks) {
    const latest = latestAttestation(input.attestations.commit, 'check', name);
    const status = latest === undefined || latest.subject !== input.subject ? 'missing' : latest.version !== version ? 'stale' : latest.result;
    statuses.push({ name, status });
  }
  return statuses.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const CHECK_REASONS: Readonly<Record<string, string>> = {
  missing: 'no result for this commit',
  stale: 'the result is for another version of the check',
  unusable: 'cannot run',
};

function checkReasons(input: PolicyInput): string[] {
  return checkStatuses(input)
    .filter((check) => check.status !== 'pass')
    .map((check) => `${check.name}: ${CHECK_REASONS[check.status] ?? check.status}`);
}

function ownerReasons(input: PolicyInput): string[] {
  const approved = input.owners.some((owner) => {
    const latest = latestAttestation(input.attestations.commit, 'approval', owner);
    return latest?.result === 'pass' && latest.subject === input.subject;
  });
  return approved ? [] : ['no owner has approved this commit'];
}

function judgementReasons(input: PolicyInput, name: string, changes: readonly PolicyChange[]): string[] {
  return changes.flatMap((change) => {
    const version = change.judgementVersions[name];
    if (version === undefined) return [`${change.path}: no judgement "${name}" is defined for it`];
    const content = change.content;
    const latest = content === undefined ? undefined : latestAttestation(input.attestations.content.get(content) ?? [], 'judgement', name);
    if (latest === undefined || latest.subject !== content) return [`${change.path}: not judged in its current content`];
    if (latest.version !== version) return [`${change.path}: judged under other axes`];
    return latest.result === 'pass' ? [] : [`${change.path}: ${latest.result}`];
  });
}

const ORDER = (r: Requirement): string => (r === 'checks' ? '0' : r === 'owner' ? '1' : `2${r}`);

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const needing = new Map<Requirement, PolicyChange[]>();
  for (const change of input.changes) {
    for (const requirement of requirementsFor(change, input.tainted)) needing.set(requirement, [...(needing.get(requirement) ?? []), change]);
  }
  const requirements = [...needing]
    .sort(([a], [b]) => (ORDER(a) < ORDER(b) ? -1 : ORDER(a) > ORDER(b) ? 1 : 0))
    .map(([requirement, changes]): RequirementVerdict => {
      const reasons =
        requirement === 'checks' ? checkReasons(input)
        : requirement === 'owner' ? ownerReasons(input)
        : judgementReasons(input, judgementName(requirement), changes);
      return { requirement, paths: changes.map((c) => c.path).sort(), met: reasons.length === 0, reasons };
    });
  return { satisfied: requirements.every((r) => r.met), requirements };
}
