// Reading the contracts that govern a path, at one commit.
//
// A `_contract.md` governs its directory and everything below it, so a path's
// governing contracts are those of each directory from the root down to its
// own. Contracts are instructions, so they are read from a commit — the caller
// passes the accepted `main` — never from a working tree or a branch tip. A
// governing contract that cannot be parsed fails the whole result.

import { describeDocumentError, parseDocument } from '../documents/index.ts';
import { listTree, pathTypeAt, readBlobs, resolveRevision, type Git, type GitError, type Sha } from '../git/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { ROOT_CONTRACT, mergeContracts, type ContractFile, type EffectiveContract } from './merge.ts';

export type ContractError = GitError | { readonly reason: 'invalid-contract'; readonly issues: readonly Issue[] };

/** The directory a `_contract.md` governs (`''` for the root's), or undefined when `path` is not a contract file. */
export function contractDirectory(path: string): string | undefined {
  if (path === ROOT_CONTRACT) return '';
  return path.endsWith(`/${ROOT_CONTRACT}`) ? path.slice(0, -ROOT_CONTRACT.length - 1) : undefined;
}

/** The directories whose contracts govern `path`, root (`''`) first. */
function governingDirectories(path: string, isDirectory: boolean): string[] {
  const parts = path === '' ? [] : path.split('/');
  const directories = isDirectory ? parts : parts.slice(0, -1);
  return ['', ...directories.map((_, i) => directories.slice(0, i + 1).join('/'))];
}

export interface ContractReader {
  /** The effective contract for a file, existing or not yet created. */
  forFile(path: string): Promise<Result<EffectiveContract, ContractError>>;
  /** The effective contract for a directory, including its own contract. */
  forDirectory(path: string): Promise<Result<EffectiveContract, ContractError>>;
}

type ContractFiles = ReadonlyMap<string, Result<ContractFile, ContractError>>;

/** Every contract at the commit, by the directory it governs; one that cannot be parsed is its error. */
async function readContractFiles(git: Git, repo: string, sha: Sha): Promise<Result<ContractFiles, GitError>> {
  const tree = await listTree(git, repo, sha);
  if (!tree.ok) return tree;
  const entries = tree.value.flatMap((entry) => {
    const directory = contractDirectory(entry.path);
    return directory === undefined ? [] : [{ ...entry, directory }];
  });
  const blobs = await readBlobs(git, repo, entries);
  if (!blobs.ok) return blobs;
  const files = new Map<string, Result<ContractFile, ContractError>>();
  for (const { path, sha: blob, directory } of entries) {
    const parsed = parseDocument(blobs.value.get(blob)?.toString('utf8') ?? '');
    files.set(directory, parsed.ok
      ? ok({ path, frontmatter: parsed.value.frontmatter, body: parsed.value.body })
      : err({ reason: 'invalid-contract', issues: [{ path, message: describeDocumentError(parsed.error) }] }));
  }
  return ok(files);
}

/**
 * Reads contracts at one commit. The first path asked for lists the tree and
 * reads every contract in it together — a few processes however many
 * directories the tree has — and each is parsed once however many paths ask.
 */
export function contractReader(git: Git, repo: string, sha: Sha): ContractReader {
  let files: Promise<Result<ContractFiles, GitError>> | undefined;
  // A Git failure is not kept, so a passing one is tried again by the next path.
  const all = (): Promise<Result<ContractFiles, GitError>> => (files ??= readContractFiles(git, repo, sha).then((read) => {
    if (!read.ok) files = undefined;
    return read;
  }));

  const effective = async (path: string, isDirectory: boolean): Promise<Result<EffectiveContract, ContractError>> => {
    const read = await all();
    if (!read.ok) return read;
    const chain: ContractFile[] = [];
    for (const directory of governingDirectories(path, isDirectory)) {
      const found = read.value.get(directory);
      if (found === undefined) continue;
      if (!found.ok) return found;
      chain.push(found.value);
    }
    const merged = mergeContracts(chain);
    return merged.ok ? merged : err({ reason: 'invalid-contract', issues: merged.error });
  };

  return {
    forFile: (path) => effective(path, false),
    forDirectory: (path) => effective(path, true),
  };
}

/** The effective contract for `path` — a file or a directory — at `revision`. */
export async function effectiveContract(
  git: Git, repo: string, revision: string, path: string,
): Promise<Result<EffectiveContract, ContractError>> {
  const sha = await resolveRevision(git, repo, revision);
  if (!sha.ok) return sha;
  const type = await pathTypeAt(git, repo, sha.value, path);
  if (!type.ok) return type;
  return effectiveContractWith(contractReader(git, repo, sha.value), type.value, path);
}

/** The effective contract for `path` from `reader`: a directory's own, or a file's (existing or not). */
export function effectiveContractWith(
  reader: ContractReader, type: 'file' | 'directory' | undefined, path: string,
): Promise<Result<EffectiveContract, ContractError>> {
  return type === 'directory' ? reader.forDirectory(path) : reader.forFile(path);
}
