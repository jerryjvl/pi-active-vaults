// Updating a vault's part of the index (core.md "Search", security.md).
//
// An index update is a propagating action: it is refused while `main` has an
// unaccepted change, and it reads only the accepted `main` — never a working
// tree or a branch — so unreviewed text never becomes searchable. Which
// documents are searched is the contracts' `index` key: `default`, `opt-in`
// (searched only within an explicit scope) or `none`; a document whose
// governing contract cannot be read is left out, since it might say `none`.
// `.vault/` holds the package's own files and is never indexed.
//
// The documents are compared by blob with what is indexed, and every change —
// documents, chunks, the commit indexed — is applied in one transaction, so a
// reader sees the vault as of one accepted `main` or the next. Vectors are
// added afterwards, for chunks without one, when an embedding model is
// configured and allowed for the vault; a model other than the one the index
// recorded drops every vector first (a different model needs a rebuild). A
// failure to embed leaves keyword search intact and is retried next time.

import { contractReader } from '../contracts/index.ts';
import { inPackageDirectory, isDocumentPath } from '../documents/index.ts';
import { TREE_MODES, listTree, readTextAt, type GitError, type Sha } from '../git/index.ts';
import { requireNoUnacceptedChange, type UnacceptedChangeError, type VaultLocation } from '../integrity/index.ts';
import { embed, type ModelError } from '../models/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';
import { chunkDocument, embeddingText, type Chunk } from './chunks.ts';
import { searchModel, vectorBlob, type SearchContext } from './context.ts';
import { EMBEDDING_MODEL_KEY } from './schema.ts';

export type IndexScope = 'default' | 'opt-in';

export type VectorState =
  | { readonly state: 'complete' }
  | { readonly state: 'none'; readonly reason: 'no-embed-model' | 'not-allowed' | 'no-vector-extension' }
  | { readonly state: 'failed'; readonly error: ModelError };

export interface IndexReport {
  readonly vault: string;
  readonly sha: Sha;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: 'invalid-contract' }[];
  readonly vectors: VectorState;
}

export type IndexError = UnacceptedChangeError | GitError;

interface Wanted {
  readonly path: string;
  readonly blob: string;
  readonly scope: IndexScope;
}

interface Prepared extends Wanted {
  readonly title: string;
  readonly chunks: readonly Chunk[];
}

function writeDocument(tx: Queryable, vault: string, document: Prepared): void {
  tx.run('DELETE FROM search_chunks WHERE vault = ? AND path = ?', [vault, document.path]);
  tx.run(
    `INSERT INTO search_documents (vault, path, blob, title, scope) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (vault, path) DO UPDATE SET blob = excluded.blob, title = excluded.title, scope = excluded.scope`,
    [vault, document.path, document.blob, document.title, document.scope],
  );
  document.chunks.forEach((chunk, ordinal) => {
    tx.run('INSERT INTO search_chunks (vault, path, ordinal, heading, header, body) VALUES (?, ?, ?, ?, ?, ?)',
      [vault, document.path, ordinal, JSON.stringify(chunk.heading), chunk.header, chunk.body]);
  });
}

function removeDocument(tx: Queryable, vault: string, path: string): void {
  tx.run('DELETE FROM search_chunks WHERE vault = ? AND path = ?', [vault, path]);
  tx.run('DELETE FROM search_documents WHERE vault = ? AND path = ?', [vault, path]);
}

async function addVectors(context: SearchContext, vault: string): Promise<VectorState> {
  const model = searchModel(context, 'embed', [vault]);
  if (!model.ok) return { state: 'none', reason: model.error.reason === 'no-default' ? 'no-embed-model' : 'not-allowed' };
  if (!context.index.vectors) return { state: 'none', reason: 'no-vector-extension' };
  const { index } = context;
  const modelId = model.value.entry.model;
  index.transaction((tx) => {
    const recorded = tx.get<{ value: string }>('SELECT value FROM search_meta WHERE key = ?', [EMBEDDING_MODEL_KEY])?.value;
    if (recorded === modelId) return;
    tx.run('DELETE FROM search_vectors');
    tx.run('INSERT INTO search_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [EMBEDDING_MODEL_KEY, modelId]);
  });
  const missing = index.all<{ id: number; header: string; body: string }>(
    `SELECT c.id, c.header, c.body FROM search_chunks c LEFT JOIN search_vectors v ON v.chunk = c.id
     WHERE c.vault = ? AND v.chunk IS NULL ORDER BY c.id`,
    [vault],
  );
  if (missing.length === 0 || context.models === undefined) return { state: 'complete' };
  const vectors = await embed(context.models.client, model.value, missing.map(embeddingText));
  if (!vectors.ok) return { state: 'failed', error: vectors.error };
  index.transaction((tx) => {
    // A chunk replaced while its vector was being made gets none; the next update embeds its successor.
    missing.forEach(({ id }, i) => {
      tx.run('INSERT OR REPLACE INTO search_vectors (chunk, embedding) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM search_chunks WHERE id = ?)',
        [id, vectorBlob(vectors.value[i] ?? []), id]);
    });
  });
  return { state: 'complete' };
}

/** Brings the vault's part of the index up to its accepted `main`. */
export async function updateIndex(context: SearchContext, vault: VaultLocation): Promise<Result<IndexReport, IndexError>> {
  const { git, index } = context;
  const accepted = await requireNoUnacceptedChange(git, context.state, vault);
  if (!accepted.ok) return accepted;
  const sha = accepted.value.sha;
  const tree = await listTree(git, vault.path, sha);
  if (!tree.ok) return tree;

  const contracts = contractReader(git, vault.path, sha);
  const wanted: Wanted[] = [];
  const skipped: { path: string; reason: 'invalid-contract' }[] = [];
  for (const entry of tree.value) {
    if (!isDocumentPath(entry.path) || inPackageDirectory(entry.path) || entry.mode === TREE_MODES.symlink) continue;
    const contract = await contracts.forFile(entry.path);
    if (!contract.ok) {
      if (contract.error.reason !== 'invalid-contract') return err(contract.error);
      skipped.push({ path: entry.path, reason: 'invalid-contract' });
      continue;
    }
    const scope = contract.value.values['index'] ?? 'default';
    if (scope === 'default' || scope === 'opt-in') wanted.push({ path: entry.path, blob: entry.sha, scope });
  }

  const indexed = new Map(index.all<{ path: string; blob: string; scope: string }>(
    'SELECT path, blob, scope FROM search_documents WHERE vault = ?', [vault.id],
  ).map((row) => [row.path, row]));
  const prepared: Prepared[] = [];
  const rescoped: Wanted[] = [];
  for (const document of wanted) {
    const before = indexed.get(document.path);
    if (before?.blob === document.blob) {
      if (before.scope !== document.scope) rescoped.push(document);
      continue;
    }
    const text = await readTextAt(git, vault.path, sha, document.path);
    if (!text.ok) return text;
    prepared.push({ ...document, ...chunkDocument(vault.id, document.path, text.value ?? '') });
  }
  const keep = new Set(wanted.map((w) => w.path));
  const removed = [...indexed.keys()].filter((path) => !keep.has(path)).sort();

  index.transaction((tx) => {
    for (const path of removed) removeDocument(tx, vault.id, path);
    for (const document of prepared) writeDocument(tx, vault.id, document);
    for (const { path, scope } of rescoped) tx.run('UPDATE search_documents SET scope = ? WHERE vault = ? AND path = ?', [scope, vault.id, path]);
    tx.run('INSERT INTO search_vaults (vault, sha, updated) VALUES (?, ?, ?) ON CONFLICT (vault) DO UPDATE SET sha = excluded.sha, updated = excluded.updated',
      [vault.id, sha, context.clock.now().toISOString()]);
  });

  return ok({
    vault: vault.id,
    sha,
    added: prepared.filter((d) => !indexed.has(d.path)).map((d) => d.path).sort(),
    changed: prepared.filter((d) => indexed.has(d.path)).map((d) => d.path).sort(),
    removed,
    skipped,
    vectors: await addVectors(context, vault.id),
  });
}
