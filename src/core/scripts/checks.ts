// Running checks (concepts.md "Script", "Attestation and merge policy"): each
// check on the accepted `main` assesses one exact commit, and its verdict is
// recorded as an attestation about that commit, at the check's version.
//
// A check runs like any script (`runScript`, so it is resolved from the
// accepted `main` and refused while `main` has an unaccepted change), in a
// fresh export of the commit's tree — what was committed, never a working
// tree — with the proposal on standard input as canonical JSON:
// `{ vault, commit, base, actor, changes: [{ change, path, oldPath? }] }`,
// `base` being where the commit's history meets the accepted `main`.
//
// Its verdict: exit 0 is `pass`, any other exit `fail`; a check that cannot
// reach one — timed out, unable to run, or not a valid check — is `error`,
// which never passes (principle 9). The first line of its output is the
// evidence. Every check on the accepted `main` is blocking: the `checks`
// requirement needs them all.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAttestation, type AttestationError } from '../attestations/index.ts';
import { changedPaths, exportTree, mergeBase, type Attribution, type Git, type Sha } from '../git/index.ts';
import { requireNoUnacceptedChange, type VaultLocation } from '../integrity/index.ts';
import { canonicalJson, ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';
import { listScripts } from './resolve.ts';
import { runScript, type ScriptRunError, type ScriptRunOptions } from './run.ts';

export type CheckRunOptions = Omit<ScriptRunOptions, 'kind' | 'builtins' | 'cwd' | 'input'>;

export interface CheckResult {
  readonly name: string;
  readonly result: 'pass' | 'fail' | 'error';
  /** The check's path and blob SHA on the accepted main; absent for one that is not a valid check. */
  readonly path?: string;
  readonly version?: Sha;
  readonly evidence?: string;
}

export interface CheckRun {
  readonly results: readonly CheckResult[];
  /** Every check passed (none at all counts). */
  readonly passed: boolean;
}

const MAX_EVIDENCE = 500;

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim();
  return line === undefined ? undefined : line.length <= MAX_EVIDENCE ? line : `${line.slice(0, MAX_EVIDENCE - 1)}…`;
}

const byName = (a: CheckResult, b: CheckResult): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export async function runChecks(
  context: { readonly git: Git; readonly store: Queryable; readonly vault: VaultLocation },
  subject: { readonly commit: Sha; readonly actor: string },
  options: CheckRunOptions,
): Promise<Result<CheckRun, ScriptRunError>> {
  const { git, vault } = context;
  const accepted = await requireNoUnacceptedChange(git, context.store, vault);
  if (!accepted.ok) return accepted;
  const checks = await listScripts(git, vault.path, accepted.value, { kind: 'check', builtins: [] });
  if (!checks.ok) return checks;
  const results: CheckResult[] = checks.value.invalid.map((check) => ({ name: check.name, result: 'error', evidence: 'not a valid check' }));
  if (checks.value.scripts.length === 0) return ok({ results, passed: results.length === 0 });

  const base = await mergeBase(git, vault.path, accepted.value.sha, subject.commit);
  if (!base.ok) return base;
  const changes = await changedPaths(git, vault.path, base.value ?? null, subject.commit);
  if (!changes.ok) return changes;
  const input = canonicalJson({ vault: vault.id, commit: subject.commit, base: base.value ?? null, actor: subject.actor, changes: changes.value });

  const tree = mkdtempSync(join(tmpdir(), 'pav-check-'));
  try {
    const exported = await exportTree(git, vault.path, subject.commit, tree);
    if (!exported.ok) return exported;
    for (const check of checks.value.scripts) {
      const ran = await runScript(context, check.name, [], { ...options, kind: 'check', builtins: [], cwd: tree, input });
      const known = { name: check.name, path: check.path, version: check.version };
      if (!ran.ok) {
        if (ran.error.reason !== 'cannot-run') return ran; // the vault itself changed meanwhile: no verdict on anything
        results.push({ ...known, result: 'error', evidence: `could not run: ${ran.error.detail}` });
      } else if (ran.value.timedOut) {
        results.push({ ...known, result: 'error', evidence: `timed out after ${options.timeoutMs} ms` });
      } else {
        const evidence = firstLine(ran.value.stdout);
        results.push({ ...known, result: ran.value.exitCode === 0 ? 'pass' : 'fail', ...(evidence === undefined ? {} : { evidence }) });
      }
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  results.sort(byName);
  return ok({ results, passed: results.every((r) => r.result === 'pass') });
}

/** Records each verdict about `commit` as a check attestation, `by` the check's path at its version. */
export async function recordCheckResults(
  git: Git, repo: string, commit: Sha, results: readonly CheckResult[], attribution: Attribution & { readonly date: Date },
): Promise<Result<void, AttestationError>> {
  for (const result of results) {
    if (result.path === undefined || result.version === undefined) continue; // not a check that can be attested at a version
    const recorded = await recordAttestation(git, repo, {
      kind: 'check',
      name: result.name,
      subject: commit,
      result: result.result,
      by: result.path,
      version: result.version,
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      at: attribution.date.toISOString(),
    }, attribution);
    if (!recorded.ok) return recorded;
  }
  return ok(undefined);
}
