// Reads from the accepted `main` (architecture.md "Reads from the accepted
// main"): one cache, in memory, for everything read from a vault's accepted
// main — its identity, contracts, documents' conditions, jobs, script and
// check lists, the job documents a run is briefed with. Each process keeps one
// for as long as it reads (a CLI command, a Pi session, the daemon).
//
// The rule:
//  - a read is keyed by vault and accepted-main SHA, and loaded once: content
//    at a commit never changes, so nothing is re-read while the accepted main
//    is unchanged;
//  - callers look up the accepted main on each operation (`acceptedMain`, one
//    state-database read) and pass it in, so a newer accepted SHA makes the
//    next read load fresh content — and what was read at the older one is
//    dropped, keeping one SHA per vault;
//  - only the accepted main is ever a key: the branded `AcceptedMain` cannot
//    name an unaccepted commit, so an unaccepted change is never read;
//  - a read that failed (an error value, or a throw) is not kept, so a
//    passing Git failure is tried again rather than remembered;
//  - documents' frontmatter is also kept across processes (`frontmatter.ts`),
//    by blob, so a new process or a new accepted main parses only what changed.
//
// The vault catalog in a session's system prompt is not one of these reads:
// it is fixed for the session (pi-conventions.md "Prompt-cache stability").

import { effectiveContractWith, contractReader, type ContractError, type ContractReader, type EffectiveContract } from '../contracts/index.ts';
import { readDocumentAt, type CommittedDocument } from '../documents/index.ts';
import { pathTypeAt, type Git, type GitError } from '../git/index.ts';
import { readVaultIdentity, type IdentityError, type VaultIdentity } from '../registry/index.ts';
import type { Result } from '../result/index.ts';
import type { AcceptedMain } from './accepted.ts';
import { scanFrontmatter, type CommittedFrontmatter, type FrontmatterCache } from './frontmatter.ts';

export interface AcceptedReads {
  /** What `load` gives for `key` at the vault's accepted main `accepted`, loaded once while it stays accepted. */
  read<T>(accepted: AcceptedMain, key: string, load: () => Promise<T>): Promise<T>;
  /** Parsed frontmatter kept beyond this process, when there is somewhere to keep it. */
  readonly frontmatter?: FrontmatterCache;
}

export interface AcceptedReadsOptions {
  readonly frontmatter?: FrontmatterCache;
}

/** A value that is an error result is not kept. */
function failed(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

export function createAcceptedReads(options: AcceptedReadsOptions = {}): AcceptedReads {
  const vaults = new Map<string, { sha: string; reads: Map<string, Promise<unknown>> }>();
  return {
    ...(options.frontmatter === undefined ? {} : { frontmatter: options.frontmatter }),
    read<T>(accepted: AcceptedMain, key: string, load: () => Promise<T>): Promise<T> {
      let held = vaults.get(accepted.vault);
      if (held === undefined || held.sha !== accepted.sha) {
        held = { sha: accepted.sha, reads: new Map() };
        vaults.set(accepted.vault, held);
      }
      const found = held.reads.get(key);
      if (found !== undefined) return found as Promise<T>;
      const { reads } = held;
      const loading = load().then(
        (value) => {
          if (failed(value) && reads.get(key) === loading) reads.delete(key);
          return value;
        },
        (error: unknown) => {
          if (reads.get(key) === loading) reads.delete(key);
          throw error;
        },
      );
      reads.set(key, loading);
      return loading;
    },
  };
}

/** Loads every time: for a caller that reads once (and tests of the readers themselves). */
export const UNCACHED_READS: AcceptedReads = { read: (_accepted, _key, load) => load() };

/** The vault's identity at its accepted main. */
export function acceptedIdentity(reads: AcceptedReads, git: Git, repo: string, accepted: AcceptedMain): Promise<Result<VaultIdentity, IdentityError>> {
  return reads.read(accepted, 'identity', () => readVaultIdentity(git, repo, accepted.sha));
}

/** The contracts at the accepted main, each read and parsed once. */
export function acceptedContracts(reads: AcceptedReads, git: Git, repo: string, accepted: AcceptedMain): Promise<ContractReader> {
  return reads.read(accepted, 'contracts', async () => contractReader(git, repo, accepted.sha));
}

/** The effective contract for `path` — a file or a directory — at the accepted main. */
export async function acceptedContract(
  reads: AcceptedReads, git: Git, repo: string, accepted: AcceptedMain, path: string,
): Promise<Result<EffectiveContract, ContractError>> {
  const type = await reads.read(accepted, `path-type:${path}`, () => pathTypeAt(git, repo, accepted.sha, path));
  if (!type.ok) return type;
  return effectiveContractWith(await acceptedContracts(reads, git, repo, accepted), type.value, path);
}

/** A document at the accepted main. */
export function acceptedDocument(reads: AcceptedReads, git: Git, repo: string, accepted: AcceptedMain, path: string): Promise<Result<CommittedDocument, GitError>> {
  return reads.read(accepted, `document:${path}`, () => readDocumentAt(git, repo, accepted.sha, path));
}

/** The frontmatter of every document at the accepted main, by path in tree order. */
export function acceptedFrontmatter(
  reads: AcceptedReads, git: Git, repo: string, accepted: AcceptedMain,
): Promise<Result<Map<string, CommittedFrontmatter>, GitError>> {
  return reads.read(accepted, 'frontmatter', () => scanFrontmatter(git, repo, accepted.vault, accepted.sha, reads.frontmatter));
}
