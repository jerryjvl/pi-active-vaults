// Backing up a local-mode vault (concepts.md "Review modes"): its registration
// names a Git remote, and what the vault holds is pushed there — `main`, the
// actor branches and the package's notes. The repository behind the remote is
// made by the person, anywhere Git can push; nothing here creates one.
//
// Invariants:
//  - a backup never loses history: `main` and the notes are pushed
//    fast-forward only, so a remote that has diverged is reported, never
//    overwritten; nothing is pruned, so a branch deleted here stays there;
//  - actor branches are forced, since they are reset after an accept;
//  - a remote missing from this clone is reported with what to do, not an
//    error: the remote is per machine, and a clone may not have it yet;
//  - only a local-mode vault is backed up — a forge-mode vault's remote is its
//    forge, which only forge sync pushes to.

import { listRefs, pushRefs, remoteUrl, type Git, type GitError } from '../git/index.ts';
import { MAIN_BRANCH, type VaultLocation } from '../integrity/index.ts';
import { err, ok, type Result } from '../result/index.ts';

const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const ACTORS = 'refs/heads/actor/';
// The package's own notes; a forge's copies (refs/notes/vault-forge/) are not ours to back up.
const NOTES = 'refs/notes/vault/';

export type BackupOutcome =
  | { readonly outcome: 'pushed'; readonly refs: number; readonly state: string }
  | { readonly outcome: 'unchanged'; readonly state: string };

export type BackupError =
  | GitError
  | { readonly reason: 'missing-remote'; readonly remote: string; readonly notes: string }
  | { readonly reason: 'push-refused'; readonly remote: string; readonly detail: string };

/** What to do when a vault names a remote this clone does not have. */
export function missingRemoteNotes(vault: VaultLocation, remote: string, purpose: 'backup' | 'forge'): string {
  const what = purpose === 'backup' ? 'is backed up to' : 'is reviewed on the forge at';
  return [
    `Vault "${vault.id}" ${what} the Git remote "${remote}", which this clone does not have.`,
    purpose === 'backup'
      ? '  1. Make an empty, private repository for it wherever you keep backups (a Gitea or GitHub account, a bare repository on a disk).'
      : '  1. Find the URL of the vault\'s repository on its forge.',
    `  2. git -C ${vault.path} remote add ${remote} <its URL>`,
    `  3. vault sync ${vault.id}`,
    `  Or, to stop, remove "remote: ${remote}" from the vault's entry in the installation config.`,
  ].join('\n');
}

/** The refs a backup holds, and a fingerprint of them: a backup with the same fingerprint as the last has nothing to push. */
async function backedUpRefs(git: Git, repo: string): Promise<Result<{ refspecs: string[]; state: string }, GitError>> {
  const found: { ref: string; sha: string }[] = [];
  for (const prefix of [MAIN_REF, ACTORS, NOTES]) {
    const listed = await listRefs(git, repo, prefix);
    if (!listed.ok) return listed;
    found.push(...listed.value.filter((r) => prefix !== MAIN_REF || r.ref === MAIN_REF));
  }
  // main first: a forge makes the first branch pushed to an empty repository its default branch (Gitea does).
  found.sort((a, b) => (a.ref === MAIN_REF ? -1 : b.ref === MAIN_REF ? 1 : a.ref.localeCompare(b.ref)));
  return ok({
    refspecs: found.map(({ ref }) => `${ref.startsWith(ACTORS) ? '+' : ''}${ref}:${ref}`),
    state: found.map((r) => `${r.sha} ${r.ref}`).join('\n'),
  });
}

/** Pushes a local-mode vault to its backup remote, unless its refs are as they were when `last` was pushed. */
export async function backupVault(git: Git, vault: VaultLocation & { readonly remote: string }, last?: string): Promise<Result<BackupOutcome, BackupError>> {
  const url = await remoteUrl(git, vault.path, vault.remote);
  if (!url.ok) return url;
  if (url.value === undefined) return err({ reason: 'missing-remote', remote: vault.remote, notes: missingRemoteNotes(vault, vault.remote, 'backup') });
  const refs = await backedUpRefs(git, vault.path);
  if (!refs.ok) return refs;
  if (refs.value.state === last || refs.value.refspecs.length === 0) return ok({ outcome: 'unchanged', state: refs.value.state });
  const pushed = await pushRefs(git, vault.path, vault.remote, refs.value.refspecs);
  if (!pushed.ok) {
    // A diverged main or notes ref is refused as not a fast-forward: git says which.
    const detail = pushed.error.reason === 'git-failed' ? pushed.error.stderr.trim() || pushed.error.reason : pushed.error.reason;
    return err({ reason: 'push-refused', remote: vault.remote, detail });
  }
  return ok({ outcome: 'pushed', refs: refs.value.refspecs.length, state: refs.value.state });
}
