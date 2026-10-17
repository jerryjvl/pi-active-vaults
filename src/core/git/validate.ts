// Validation of every value that reaches a git command line. Values can derive
// from vault content (actor names, branch names, paths in a diff), so each is
// checked against an allow-list shape before git sees it: nothing that could be
// read as an option, a range, an extra argument or a path outside the tree gets
// through. Failing here is an error value, never a thrown exception.

import { err, ok, type Result } from '../result/index.ts';
import type { GitError } from './exec.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REVISION = /^[A-Za-z0-9._/@~^{}+-]+$/;
const REF_NAME = /^refs\/[A-Za-z0-9._/@+-]+$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/;
const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/;

const invalid = (argument: string): Result<never, GitError> => err({ reason: 'invalid-argument', argument });

function wellFormedRefComponents(name: string): boolean {
  return !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.') && !name.endsWith('.lock') && !name.includes('@{');
}

/** Whether `value` is a full object name (SHA-1 or SHA-256), never a movable name. */
export function isSha(value: string): boolean {
  return SHA.test(value);
}

/** A full object name. Used wherever the caller must name an exact commit, never a movable name. */
export function checkSha(value: string): Result<string, GitError> {
  return isSha(value) ? ok(value) : invalid('sha');
}

/** A SHA, branch, tag or simple expression like `HEAD~1`: no leading `-`, no ranges, no whitespace. */
export function checkRevision(value: string): Result<string, GitError> {
  return REVISION.test(value) && !value.startsWith('-') && !value.includes('..') ? ok(value) : invalid('revision');
}

/** A full ref name (`refs/…`). */
export function checkRefName(value: string): Result<string, GitError> {
  return REF_NAME.test(value) && wellFormedRefComponents(value) ? ok(value) : invalid('ref');
}

/** A ref prefix as used to list refs: `refs/…`, optionally ending in `/`. */
export function checkRefPrefix(value: string): Result<string, GitError> {
  return REF_NAME.test(value) && !value.includes('..') && !value.includes('//') ? ok(value) : invalid('ref-prefix');
}

export function checkNotesRef(value: string): Result<string, GitError> {
  const ref = checkRefName(value);
  return ref.ok && value.startsWith('refs/notes/') ? ref : invalid('notes-ref');
}

/** A short branch name such as `actor/gardener`. */
export function checkBranchName(value: string): Result<string, GitError> {
  return BRANCH_NAME.test(value) && wellFormedRefComponents(value) ? ok(value) : invalid('branch');
}

/** A path inside a tree: relative, forward slashes, no `.` or `..` segments. */
export function checkTreePath(value: string): Result<string, GitError> {
  const segments = value.split('/');
  const bad =
    value === '' || value.includes('\0') || value.includes('\\') || value.startsWith('/') ||
    segments.some((s) => s === '' || s === '.' || s === '..');
  return bad ? invalid('path') : ok(value);
}

/** A trailer is `Key: value` on one line; a newline in either would let content forge further trailers. */
export function checkTrailer(key: string, value: string): Result<void, GitError> {
  return TRAILER_KEY.test(key) && value.trim() !== '' && !/[\r\n\0]/.test(value) ? ok(undefined) : invalid('trailer');
}

/** A name or email for commit identity: single line, no angle brackets. */
export function checkIdentity(name: string, email: string): Result<void, GitError> {
  const clean = (text: string): boolean => text.trim() !== '' && !/[\r\n\0<>]/.test(text);
  return clean(name) && clean(email) ? ok(undefined) : invalid('identity');
}
