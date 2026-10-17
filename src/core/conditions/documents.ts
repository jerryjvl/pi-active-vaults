// The documents on the accepted `main` that carry conditions (concepts.md
// "applies-when", "Contracts"): what jobs exist, what can be injected, and
// what an external event can reach.
//
// A document's conditions are its own `applies-when` followed by its
// effective contract's — which applies to every document in the subtree — so
// a document's own conditions keep their positions whatever its contracts
// say. Everything is read from the accepted `main`, never a branch or a
// working tree. A condition that cannot be read applies nowhere: the document
// is listed with no conditions and the issues that explain why, never with
// the conditions that happened to parse.

import { contractReader, ROOT_CONTRACT } from '../contracts/index.ts';
import { describeDocumentError, inPackageDirectory, isDocumentPath, readDocumentAt } from '../documents/index.ts';
import { listFiles, type Git, type GitError } from '../git/index.ts';
import type { AcceptedMain } from '../integrity/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { parseConditions, type Condition } from './parse.ts';

export interface DocumentConditions {
  readonly path: string;
  /** Empty when any of them cannot be read. */
  readonly conditions: readonly Condition[];
  /** The document's `budget` as written, for whoever spawns it to read. */
  readonly budget?: unknown;
  readonly issues: readonly Issue[];
}

/** Contract files govern documents; they are not documents with conditions of their own. */
function isContract(path: string): boolean {
  return path === ROOT_CONTRACT || path.endsWith(`/${ROOT_CONTRACT}`);
}

/** Every document on the accepted main with conditions, or with conditions that cannot be read, by path. */
export async function documentConditions(git: Git, repo: string, accepted: AcceptedMain): Promise<Result<DocumentConditions[], GitError>> {
  const files = await listFiles(git, repo, accepted.sha);
  if (!files.ok) return files;
  const contracts = contractReader(git, repo, accepted.sha);
  const found: DocumentConditions[] = [];
  for (const path of [...files.value].sort()) {
    if (!isDocumentPath(path) || inPackageDirectory(path) || isContract(path)) continue;
    const contract = await contracts.forFile(path);
    if (!contract.ok) {
      const { error } = contract;
      if (error.reason !== 'invalid-contract') return err(error);
      found.push({ path, conditions: [], issues: error.issues });
      continue;
    }
    const document = await readDocumentAt(git, repo, accepted.sha, path);
    if (!document.ok) return document;
    if (document.value.state === 'missing') continue;
    if (document.value.state === 'unreadable') {
      found.push({ path, conditions: [], issues: [{ path, message: describeDocumentError(document.value.error) }] });
      continue;
    }
    const { frontmatter } = document.value.document;
    const own = frontmatter['applies-when'] === undefined ? ok([]) : parseConditions(frontmatter['applies-when'], `${path}:applies-when`);
    const inherited = contract.value.values['applies-when'];
    const origin = contract.value.origins['applies-when']?.join(', ') ?? ROOT_CONTRACT;
    const governing = inherited === undefined ? ok([]) : parseConditions(inherited, `${origin}:applies-when`);
    const issues = [...(own.ok ? [] : own.error), ...(governing.ok ? [] : governing.error)];
    const conditions = own.ok && governing.ok ? [...own.value, ...governing.value] : [];
    if (conditions.length === 0 && issues.length === 0) continue;
    found.push({ path, conditions, ...(frontmatter['budget'] === undefined ? {} : { budget: frontmatter['budget'] }), issues });
  }
  return ok(found);
}
