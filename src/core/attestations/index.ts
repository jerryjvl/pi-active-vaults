// Attestations: verdicts about an exact subject — a commit, or the blob of
// judged content — stored in Git notes so they travel with the repository
// (concepts.md "Attestation and merge policy").
//
// Each subject's note holds one JSON object per line, appended in order; for
// each kind and name the latest record counts. Invariants:
//  - a record must be about the object its note is on, and every record in a
//    note must be readable — otherwise reading fails (fail closed: a gate must
//    not decide on a partial or misplaced record);
//  - records are validated before anything is written;
//  - Git notes have no compare-and-swap, so a concurrent writer can drop a
//    record; every write is re-read and retried once, then reported.
//
// Who may write an attestation is decided by the operations layer: no model
// is ever offered a way to record one about its own work.

import { isDeepStrictEqual } from 'node:util';
import { isSha, notesAppend, notesShow, type Attribution, type Git, type GitError, type Sha } from '../git/index.ts';
import { err, ok, type Result } from '../result/index.ts';

export const ATTESTATIONS_REF = 'refs/notes/vault/attestations';

export const ATTESTATION_KINDS = ['check', 'judgement', 'approval'] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

export interface Attestation {
  readonly kind: AttestationKind;
  /** Which check, judgement or approver. */
  readonly name: string;
  /** A commit SHA, or the blob SHA of judged content. */
  readonly subject: Sha;
  /** `pass`, `fail`, or a named outcome. */
  readonly result: string;
  /** The script, model or person that produced it. */
  readonly by: string;
  /** The check's blob SHA or the judgement's axes version; absent for approvals. */
  readonly version?: string;
  readonly evidence?: string;
  /** When it was recorded (ISO 8601). */
  readonly at: string;
}

export type AttestationError =
  | GitError
  | { readonly reason: 'invalid-attestation'; readonly field: string }
  /** Positions (1-based) of the records in the subject's note that could not be read. */
  | { readonly reason: 'invalid-attestations'; readonly subject: Sha; readonly records: readonly number[] }
  | { readonly reason: 'not-recorded'; readonly subject: Sha };

const MAX_EVIDENCE_CHARS = 2000;

const singleLine = (value: unknown): value is string => typeof value === 'string' && value !== '' && !/[\r\n\0]/.test(value);

/** The first field that makes `value` not an attestation, or undefined. */
function invalidField(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'record';
  const a = value as Record<string, unknown>;
  const allowed = ['kind', 'name', 'subject', 'result', 'by', 'version', 'evidence', 'at'];
  const unknown = Object.keys(a).find((key) => !allowed.includes(key));
  if (unknown !== undefined) return unknown;
  if (!ATTESTATION_KINDS.includes(a['kind'] as AttestationKind)) return 'kind';
  if (!singleLine(a['name'])) return 'name';
  if (typeof a['subject'] !== 'string' || !isSha(a['subject'])) return 'subject';
  if (!singleLine(a['result'])) return 'result';
  if (!singleLine(a['by'])) return 'by';
  if (a['version'] !== undefined && !singleLine(a['version'])) return 'version';
  if (a['evidence'] !== undefined && (typeof a['evidence'] !== 'string' || a['evidence'].length > MAX_EVIDENCE_CHARS)) return 'evidence';
  if (!singleLine(a['at'])) return 'at';
  return undefined;
}

/** One line of JSON, keys in a fixed order so equal records serialise equally. */
function serialise(a: Attestation): string {
  return JSON.stringify({
    kind: a.kind, name: a.name, subject: a.subject, result: a.result, by: a.by,
    ...(a.version === undefined ? {} : { version: a.version }),
    ...(a.evidence === undefined ? {} : { evidence: a.evidence }),
    at: a.at,
  });
}

/** Every attestation about `subject`, in the order recorded. */
export async function readAttestations(git: Git, repo: string, subject: Sha): Promise<Result<Attestation[], AttestationError>> {
  const note = await notesShow(git, repo, ATTESTATIONS_REF, subject);
  if (!note.ok) return note;
  const records = (note.value ?? '').split('\n').filter((line) => line.trim() !== '');
  const attestations: Attestation[] = [];
  const unreadable: number[] = [];
  records.forEach((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable.push(i + 1);
      return;
    }
    if (invalidField(parsed) !== undefined || (parsed as Attestation).subject !== subject) unreadable.push(i + 1);
    else attestations.push(parsed as Attestation);
  });
  return unreadable.length > 0 ? err({ reason: 'invalid-attestations', subject, records: unreadable }) : ok(attestations);
}

/** The record that counts for `kind` and `name`: the latest one. */
export function latestAttestation(attestations: readonly Attestation[], kind: AttestationKind, name: string): Attestation | undefined {
  return attestations.findLast((a) => a.kind === kind && a.name === name);
}

export async function recordAttestation(
  git: Git, repo: string, attestation: Attestation, attribution: Attribution,
): Promise<Result<void, AttestationError>> {
  const field = invalidField(attestation);
  if (field !== undefined) return err({ reason: 'invalid-attestation', field });
  const line = serialise(attestation);
  const expected: unknown = JSON.parse(line);
  for (let attempt = 0; attempt < 2; attempt++) {
    const appended = await notesAppend(git, repo, ATTESTATIONS_REF, attestation.subject, line, attribution);
    if (!appended.ok) return appended;
    const reread = await readAttestations(git, repo, attestation.subject);
    if (!reread.ok) return reread;
    if (reread.value.some((a) => isDeepStrictEqual(a, expected))) return ok(undefined);
  }
  return err({ reason: 'not-recorded', subject: attestation.subject });
}
