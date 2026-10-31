// The documents on the accepted `main` that carry conditions (concepts.md
// "applies-when", "Contracts"): what jobs exist, what can be injected, and
// what an external event can reach.
//
// A document's conditions are its own `applies-when` followed by its
// effective contract's — which applies to every document in the subtree — so
// a document's own conditions keep their positions whatever its contracts
// say. The actor a job writes as is likewise its own `actor`, else its
// nearest contract's (strategy `nearest`), and so is the model it asks for. Everything is read from the
// accepted `main` — the whole tree's frontmatter in one scan, once per accepted
// main, through the reads cache — never a branch or a working tree. A condition that cannot be read applies nowhere:
// the document is listed with no conditions and the issues that explain why,
// never with the conditions that happened to parse.

import { ROOT_CONTRACT, contractDirectory, type EffectiveContract } from '../contracts/index.ts';
import { describeDocumentError, inPackageDirectory } from '../documents/index.ts';
import type { Git, GitError } from '../git/index.ts';
import { UNCACHED_READS, acceptedContracts, acceptedFrontmatter, type AcceptedMain, type AcceptedReads } from '../integrity/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { parseConditions, type Condition } from './parse.ts';

/** A key as written, with the file it comes from. */
export interface Inherited {
  readonly value: unknown;
  readonly origin: string;
}

export interface DocumentConditions {
  readonly path: string;
  /** Empty when any of them cannot be read. */
  readonly conditions: readonly Condition[];
  /** The document's `budget` as written, for whoever spawns it to read. */
  readonly budget?: unknown;
  /** The `actor` it runs as, as written — its own, else its nearest contract's — and the file that says so. */
  readonly actor?: Inherited;
  /** The `model` it asks for, likewise. */
  readonly model?: Inherited;
  /** The document's own `web` block as written, for whoever spawns it to read; never inherited from a contract. */
  readonly web?: unknown;
  readonly issues: readonly Issue[];
}

/** A `nearest` key: the document's own value, else its effective contract's, with where it is written. */
function ownOrNearest(key: string, path: string, frontmatter: Readonly<Record<string, unknown>>, contract: EffectiveContract): Inherited | undefined {
  if (frontmatter[key] !== undefined) return { value: frontmatter[key], origin: path };
  const inherited = contract.values[key];
  return inherited === undefined ? undefined : { value: inherited, origin: contract.origins[key]?.at(-1) ?? ROOT_CONTRACT };
}

/** Every document on the accepted main with conditions, or with conditions that cannot be read, by path. */
export function documentConditions(git: Git, repo: string, accepted: AcceptedMain, reads: AcceptedReads = UNCACHED_READS): Promise<Result<DocumentConditions[], GitError>> {
  return reads.read(accepted, 'conditions', () => readConditions(git, repo, accepted, reads));
}

async function readConditions(git: Git, repo: string, accepted: AcceptedMain, reads: AcceptedReads): Promise<Result<DocumentConditions[], GitError>> {
  const documents = await acceptedFrontmatter(reads, git, repo, accepted);
  if (!documents.ok) return documents;
  const contracts = await acceptedContracts(reads, git, repo, accepted);
  const found: DocumentConditions[] = [];
  for (const [path, document] of [...documents.value].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // Contract files govern documents; they are not documents with conditions of their own.
    if (inPackageDirectory(path) || contractDirectory(path) !== undefined) continue;
    const contract = await contracts.forFile(path);
    if (!contract.ok) {
      const { error } = contract;
      if (error.reason !== 'invalid-contract') return err(error);
      found.push({ path, conditions: [], issues: error.issues });
      continue;
    }
    if (document.state === 'unreadable') {
      found.push({ path, conditions: [], issues: [{ path, message: describeDocumentError(document.error) }] });
      continue;
    }
    const { frontmatter } = document;
    const own = frontmatter['applies-when'] === undefined ? ok([]) : parseConditions(frontmatter['applies-when'], `${path}:applies-when`);
    const inherited = contract.value.values['applies-when'];
    const origin = contract.value.origins['applies-when']?.join(', ') ?? ROOT_CONTRACT;
    const governing = inherited === undefined ? ok([]) : parseConditions(inherited, `${origin}:applies-when`);
    const issues = [...(own.ok ? [] : own.error), ...(governing.ok ? [] : governing.error)];
    const conditions = own.ok && governing.ok ? [...own.value, ...governing.value] : [];
    if (conditions.length === 0 && issues.length === 0) continue;
    const actor = ownOrNearest('actor', path, frontmatter, contract.value);
    const model = ownOrNearest('model', path, frontmatter, contract.value);
    found.push({
      path, conditions, issues,
      ...(frontmatter['budget'] === undefined ? {} : { budget: frontmatter['budget'] }),
      ...(actor === undefined ? {} : { actor }),
      ...(model === undefined ? {} : { model }),
      ...(frontmatter['web'] === undefined ? {} : { web: frontmatter['web'] }),
    });
  }
  return ok(found);
}
