// A vault's identity: the `vault` key of its root contract (concepts.md
// "Contracts"). It names who owns the vault and who may write to it, so it is
// read from a commit (the accepted `main`) and validated strictly — an unknown
// key is an error, because a misspelt `owners` must not quietly leave a vault
// without owners.

import { VAULT_ID } from '../config/index.ts';
import { ROOT_CONTRACT, contractReader, type ContractError } from '../contracts/index.ts';
import { resolveRevision, type Git } from '../git/index.ts';
import { DataReader, err, issuePath, type Issue, type Result } from '../result/index.ts';

export const REVIEW_MODES = ['local', 'forge'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export interface VaultIdentity {
  readonly id: string;
  readonly purpose: { readonly summary: string; readonly useFor: readonly string[]; readonly notFor: readonly string[] };
  readonly audience: string;
  readonly owners: readonly string[];
  /** Agent roles; an actor is one of these or an owner. */
  readonly actors: readonly string[];
  /** The only installation that runs the vault's jobs, when set. */
  readonly executor?: string;
  readonly review: ReviewMode;
  /** Where the vault was created from; recorded by `templates`. */
  readonly fromTemplate?: Readonly<Record<string, unknown>>;
}

export type IdentityError =
  | ContractError
  | { readonly reason: 'no-identity' }
  | { readonly reason: 'invalid-identity'; readonly issues: readonly Issue[] };

/**
 * Owner and actor names become branch names (`actor/<name>`) and directory
 * names, so they are limited to a shape that is safe as both everywhere.
 */
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?!\.|lock$|$))*$/;
const INSTALLATION_NAME = /^\S+$/;

function readNames(r: DataReader, value: unknown, path: string): string[] {
  const seen = new Set<string>();
  return r.list(value, path).map((item, i) => {
    const name = r.string(item, `${path}[${i}]`, NAME);
    if (name !== '' && seen.has(name)) r.add(`${path}[${i}]`, 'repeats an earlier name');
    seen.add(name);
    return name;
  });
}

export function parseVaultIdentity(value: unknown, path = 'vault'): Result<VaultIdentity, Issue[]> {
  const r = new DataReader();
  const v = r.record(value, path, ['id', 'purpose', 'audience', 'owners', 'actors', 'executor', 'review', 'from-template']);
  const id = r.string(v['id'], issuePath(path, 'id'), VAULT_ID);
  const purposePath = issuePath(path, 'purpose');
  const p = r.record(v['purpose'] ?? {}, purposePath, ['summary', 'use-for', 'not-for']);
  const summary = r.string(p['summary'], issuePath(purposePath, 'summary'));
  const useFor = r.stringList(p['use-for'] ?? [], issuePath(purposePath, 'use-for'));
  const notFor = r.stringList(p['not-for'] ?? [], issuePath(purposePath, 'not-for'));
  const audience = r.string(v['audience'], issuePath(path, 'audience'));
  const owners = readNames(r, v['owners'] ?? [], issuePath(path, 'owners'));
  if (Array.isArray(v['owners'] ?? []) && owners.length === 0) r.add(issuePath(path, 'owners'), 'must name at least one owner');
  const actors = readNames(r, v['actors'], issuePath(path, 'actors'));
  const executor = r.optionalString(v, 'executor', path, INSTALLATION_NAME);
  const review = v['review'] === undefined ? 'local' : r.oneOf(v['review'], issuePath(path, 'review'), REVIEW_MODES) ?? 'local';
  const fromTemplate = v['from-template'] === undefined ? undefined : r.record(v['from-template'], issuePath(path, 'from-template'));
  return r.result({
    id,
    purpose: { summary, useFor, notFor },
    audience,
    owners,
    actors,
    ...(executor === undefined ? {} : { executor }),
    review,
    ...(fromTemplate === undefined ? {} : { fromTemplate }),
  });
}

/** The identity declared by the root contract at `revision`. */
export async function readVaultIdentity(git: Git, repo: string, revision: string): Promise<Result<VaultIdentity, IdentityError>> {
  const sha = await resolveRevision(git, repo, revision);
  if (!sha.ok) return sha;
  const root = await contractReader(git, repo, sha.value).forDirectory('');
  if (!root.ok) return root;
  const declared = root.value.values['vault'];
  if (declared === undefined) return err({ reason: 'no-identity' });
  const parsed = parseVaultIdentity(declared, `${ROOT_CONTRACT}:vault`);
  return parsed.ok ? parsed : err({ reason: 'invalid-identity', issues: parsed.error });
}

export function isOwner(identity: VaultIdentity, person: string): boolean {
  return identity.owners.includes(person);
}

/** Everyone who may write to the vault on their own actor branch: its actors, then its owners. */
export function writersOf(identity: VaultIdentity): string[] {
  return [...new Set([...identity.actors, ...identity.owners])];
}

/** Whether `name` may write to the vault on its own actor branch. */
export function isActor(identity: VaultIdentity, name: string): boolean {
  return writersOf(identity).includes(name);
}
