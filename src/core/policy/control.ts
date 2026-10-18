// Control changes (concepts.md "Merge policy"): a change to any `_contract.md`,
// anything under `.vault/`, or a document's `applies-when`, `budget` or `actor`
// — what decides how the vault instructs, runs and gates, and whom a job
// writes as. Whatever the contracts say, such a change needs an owner.
//
// Detection errs towards flagging. Names are compared case-insensitively,
// because a case-insensitive file system would treat `_Contract.md` as the
// contract; a document whose frontmatter cannot be read on either side counts,
// because its conditions cannot be shown to be unchanged.

import { isDeepStrictEqual } from 'node:util';
import { ROOT_CONTRACT } from '../contracts/index.ts';
import { inPackageDirectory, isDocumentPath, readDocumentAt } from '../documents/index.ts';
import type { FileChange, Git, GitError, Sha } from '../git/index.ts';
import { ok, type Result } from '../result/index.ts';

/** Document keys whose change is a control change. */
export const CONTROL_KEYS = ['applies-when', 'budget', 'actor'] as const;

export interface ControlChange {
  readonly path: string;
  readonly reason: 'contract' | 'vault-directory' | 'control-keys' | 'unreadable-frontmatter';
}

/** Why a path is control by its name alone, if it is. */
export function controlPathReason(path: string): 'contract' | 'vault-directory' | undefined {
  if (inPackageDirectory(path)) return 'vault-directory';
  if (path.toLowerCase().split('/').at(-1) === ROOT_CONTRACT) return 'contract';
  return undefined;
}

type ControlFields = { readonly [K in (typeof CONTROL_KEYS)[number]]?: unknown };

/** The control keys of a document at a revision: absent document → none; unreadable → undefined. */
async function controlFields(git: Git, repo: string, revision: Sha, path: string): Promise<Result<ControlFields | undefined, GitError>> {
  const read = await readDocumentAt(git, repo, revision, path);
  if (!read.ok) return read;
  if (read.value.state === 'missing') return ok({});
  if (read.value.state === 'unreadable') return ok(undefined);
  const { frontmatter } = read.value.document;
  return ok(Object.fromEntries(CONTROL_KEYS.filter((key) => frontmatter[key] !== undefined).map((key) => [key, frontmatter[key]])));
}

/** The control changes among `changes` (from `base` — null: from nothing — to `head`), in path order. */
export async function findControlChanges(
  git: Git, repo: string, base: Sha | null, head: Sha, changes: readonly FileChange[],
): Promise<Result<ControlChange[], GitError>> {
  const found: ControlChange[] = [];
  for (const change of changes) {
    const before = change.oldPath ?? change.path;
    const byName = controlPathReason(change.path) ?? controlPathReason(before);
    if (byName !== undefined) {
      found.push({ path: change.path, reason: byName });
      continue;
    }
    if (!isDocumentPath(change.path) && !isDocumentPath(before)) continue;
    const was = change.change === 'created' || base === null ? ok({}) : await controlFields(git, repo, base, before);
    if (!was.ok) return was;
    const is = change.change === 'deleted' ? ok({}) : await controlFields(git, repo, head, change.path);
    if (!is.ok) return is;
    if (was.value === undefined || is.value === undefined) found.push({ path: change.path, reason: 'unreadable-frontmatter' });
    else if (!isDeepStrictEqual(was.value, is.value)) found.push({ path: change.path, reason: 'control-keys' });
  }
  return ok(found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
