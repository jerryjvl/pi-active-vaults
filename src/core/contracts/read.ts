// Reading the contracts that govern a path, at one commit.
//
// A `_contract.md` governs its directory and everything below it, so a path's
// governing contracts are those of each directory from the root down to its
// own. Contracts are instructions, so they are read from a commit — the caller
// passes the accepted `main` — never from a working tree or a branch tip. A
// governing contract that cannot be parsed fails the whole result.

import { describeDocumentError, readDocumentAt } from '../documents/index.ts';
import { pathTypeAt, resolveRevision, type Git, type GitError, type Sha } from '../git/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { ROOT_CONTRACT, mergeContracts, type ContractFile, type EffectiveContract } from './merge.ts';

export type ContractError = GitError | { readonly reason: 'invalid-contract'; readonly issues: readonly Issue[] };

function contractFileIn(directory: string): string {
  return directory === '' ? ROOT_CONTRACT : `${directory}/${ROOT_CONTRACT}`;
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

/** Reads contracts at one commit, reading and parsing each `_contract.md` once however many paths ask. */
export function contractReader(git: Git, repo: string, sha: Sha): ContractReader {
  const files = new Map<string, Promise<Result<ContractFile | undefined, ContractError>>>();

  const read = async (directory: string): Promise<Result<ContractFile | undefined, ContractError>> => {
    const path = contractFileIn(directory);
    const document = await readDocumentAt(git, repo, sha, path);
    if (!document.ok) return document;
    switch (document.value.state) {
      case 'missing':
        return ok(undefined);
      case 'unreadable':
        return err({ reason: 'invalid-contract', issues: [{ path, message: describeDocumentError(document.value.error) }] });
      case 'read':
        return ok({ path, frontmatter: document.value.document.frontmatter, body: document.value.document.body });
    }
  };

  const effective = async (path: string, isDirectory: boolean): Promise<Result<EffectiveContract, ContractError>> => {
    const chain: ContractFile[] = [];
    for (const directory of governingDirectories(path, isDirectory)) {
      let file = files.get(directory);
      if (file === undefined) {
        file = read(directory);
        files.set(directory, file);
      }
      const found = await file;
      if (!found.ok) return found;
      if (found.value !== undefined) chain.push(found.value);
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
