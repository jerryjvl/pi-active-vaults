// A document as committed in a revision. What the package enforces is read
// from commits, never from a working tree, and every reader needs the same
// three outcomes kept apart: no such file, a file whose frontmatter cannot be
// read, and a parsed document. Each caller decides what an unreadable one
// means for it — an invalid contract, a document with no labels, a control
// change — but none can mistake it for an absent one.

import { readTextAt, type Git, type GitError } from '../git/index.ts';
import { ok, type Result } from '../result/index.ts';
import { parseDocument, type DocumentError, type ParsedDocument } from './frontmatter.ts';

export type CommittedDocument =
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable'; readonly error: DocumentError }
  | { readonly state: 'read'; readonly document: ParsedDocument };

export async function readDocumentAt(git: Git, repo: string, revision: string, path: string): Promise<Result<CommittedDocument, GitError>> {
  const text = await readTextAt(git, repo, revision, path);
  if (!text.ok) return text;
  if (text.value === undefined) return ok({ state: 'missing' });
  const parsed = parseDocument(text.value);
  return ok(parsed.ok ? { state: 'read', document: parsed.value } : { state: 'unreadable', error: parsed.error });
}
