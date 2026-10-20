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
// recorded drops every vector first (a different model needs a rebuild).
//
// Vectors are made a batch of whole documents at a time, so one refusal never
// costs the rest of the vault its vectors. Characters are a poor guide to an
// embedding model's token limit — tables of serials and addresses tokenise
// densely — so chunks aim high, and a document the model refuses is embedded
// alone and, if still refused, re-chunked at successively smaller sizes; its
// keyword chunks are replaced too, so both describe the same pieces. Nothing
// is truncated. A document refused even at the smallest size keeps keyword
// search and is reported. A failure that smaller chunks cannot cure — the
// model unreachable, timing out, refusing the credentials — stops the pass;
// the vectors made so far are kept, and the rest are retried next time.

import { contractReader } from '../contracts/index.ts';
import { inPackageDirectory, isDocumentPath } from '../documents/index.ts';
import { TREE_MODES, listTree, readTextAt, type GitError, type Sha } from '../git/index.ts';
import { requireNoUnacceptedChange, type UnacceptedChangeError, type VaultLocation } from '../integrity/index.ts';
import { embed, type ModelError } from '../models/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Queryable, Store } from '../store/index.ts';
import { chunkDocument, embeddingText, type Chunk } from './chunks.ts';
import { searchModel, vectorBlob, type SearchContext } from './context.ts';
import { EMBEDDING_MODEL_KEY } from './schema.ts';

export type IndexScope = 'default' | 'opt-in';

export type VectorState =
  /** Every chunk has its vector, except those of the documents listed, which the model refused even in the smallest chunks. */
  | { readonly state: 'complete'; readonly unembedded?: readonly string[] }
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

/** How far an update has got: documents read and chunked, then chunks given vectors. */
export interface IndexProgress {
  readonly vault: string;
  readonly phase: 'reading' | 'embedding';
  readonly done: number;
  readonly total: number;
}

export type ProgressListener = (progress: IndexProgress) => void;

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

/** Successively smaller chunk sizes for a document the embedding model refuses at the usual size. */
const RECHUNK_SIZES = [1000, 700, 450, 300];

/** A refusal smaller chunks might cure: the model answered, but not with a credentials, missing-model or rate-limit status. */
function refusedContent(error: ModelError): boolean {
  return error.reason === 'http-error' && ![401, 403, 404, 407, 429].includes(error.status);
}

interface MissingDocument {
  readonly path: string;
  readonly blob: string;
  readonly chunks: readonly { readonly id: number; readonly header: string; readonly body: string }[];
}

/** Whole documents in groups of about `batch` chunks (a larger document is a group of its own). */
function groupsOf(documents: readonly MissingDocument[], batch: number): MissingDocument[][] {
  const groups: MissingDocument[][] = [];
  let current: MissingDocument[] = [];
  let size = 0;
  for (const document of documents) {
    if (current.length > 0 && size + document.chunks.length > batch) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(document);
    size += document.chunks.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

async function addVectors(context: SearchContext, vault: VaultLocation, sha: Sha, onProgress?: ProgressListener): Promise<VectorState> {
  const model = searchModel(context, 'embed', [vault.id]);
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
  const rows = index.all<{ id: number; path: string; blob: string; header: string; body: string }>(
    `SELECT c.id, c.path, d.blob, c.header, c.body FROM search_chunks c
     JOIN search_documents d ON d.vault = c.vault AND d.path = c.path
     LEFT JOIN search_vectors v ON v.chunk = c.id
     WHERE c.vault = ? AND v.chunk IS NULL ORDER BY c.path, c.ordinal`,
    [vault.id],
  );
  if (rows.length === 0 || context.models === undefined) return { state: 'complete' };
  let embedded = 0;
  const advance = (count: number): void => {
    embedded += count;
    onProgress?.({ vault: vault.id, phase: 'embedding', done: Math.min(embedded, rows.length), total: rows.length });
  };
  const { client } = context.models;
  const byPath = new Map<string, MissingDocument>();
  for (const row of rows) {
    const document = byPath.get(row.path) ?? { path: row.path, blob: row.blob, chunks: [] };
    (document.chunks as { id: number; header: string; body: string }[]).push(row);
    byPath.set(row.path, document);
  }

  const store = (chunks: readonly { readonly id: number }[], vectors: readonly number[][]): void => {
    index.transaction((tx) => {
      // A chunk replaced while its vector was being made gets none; the next update embeds its successor.
      chunks.forEach(({ id }, i) => {
        tx.run('INSERT OR REPLACE INTO search_vectors (chunk, embedding) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM search_chunks WHERE id = ?)',
          [id, vectorBlob(vectors[i] ?? []), id]);
      });
    });
  };

  /** Embeds one document, re-chunking it smaller while the model refuses it; its error only if smaller chunks cannot help. */
  const embedAlone = async (document: MissingDocument): Promise<Result<'embedded' | 'refused', ModelError>> => {
    const first = await embed(client, model.value, document.chunks.map(embeddingText));
    if (first.ok) {
      store(document.chunks, first.value);
      return ok('embedded');
    }
    if (!refusedContent(first.error)) return err(first.error);
    const text = await readTextAt(context.git, vault.path, sha, document.path);
    if (!text.ok) return ok('refused');
    for (const size of RECHUNK_SIZES) {
      const { chunks } = chunkDocument(vault.id, document.path, text.value ?? '', size);
      const vectors = await embed(client, model.value, chunks.map(embeddingText));
      if (!vectors.ok) {
        if (refusedContent(vectors.error)) continue;
        return err(vectors.error);
      }
      index.transaction((tx) => {
        // Only if the document is still the one these chunks were made from.
        if (tx.get('SELECT 1 FROM search_documents WHERE vault = ? AND path = ? AND blob = ?', [vault.id, document.path, document.blob]) === undefined) return;
        tx.run('DELETE FROM search_chunks WHERE vault = ? AND path = ?', [vault.id, document.path]);
        chunks.forEach((chunk, ordinal) => {
          const { lastInsertRowid } = tx.run('INSERT INTO search_chunks (vault, path, ordinal, heading, header, body) VALUES (?, ?, ?, ?, ?, ?)',
            [vault.id, document.path, ordinal, JSON.stringify(chunk.heading), chunk.header, chunk.body]);
          tx.run('INSERT INTO search_vectors (chunk, embedding) VALUES (?, ?)', [Number(lastInsertRowid), vectorBlob(vectors.value[ordinal] ?? [])]);
        });
      });
      return ok('embedded');
    }
    return ok('refused');
  };

  const unembedded: string[] = [];
  let failure: ModelError | undefined;
  const groups = groupsOf([...byPath.values()], model.value.entry.batch);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < groups.length) {
      const group = groups[next++] as MissingDocument[];
      const chunks = group.flatMap((d) => d.chunks);
      const vectors = await embed(client, model.value, chunks.map(embeddingText));
      if (vectors.ok) {
        store(chunks, vectors.value);
        advance(chunks.length);
        continue;
      }
      if (!refusedContent(vectors.error)) {
        failure ??= vectors.error;
        return;
      }
      for (const document of group) {
        const alone = await embedAlone(document);
        if (!alone.ok) {
          failure ??= alone.error;
          return;
        }
        if (alone.value === 'refused') unembedded.push(document.path);
        advance(document.chunks.length);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(model.value.entry.parallel, groups.length) }, worker));
  if (failure !== undefined) return { state: 'failed', error: failure };
  return unembedded.length === 0 ? { state: 'complete' } : { state: 'complete', unembedded: unembedded.sort() };
}

/** Brings the vault's part of the index up to its accepted `main`. */
export async function updateIndex(context: SearchContext, vault: VaultLocation, onProgress?: ProgressListener): Promise<Result<IndexReport, IndexError>> {
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
  const toRead = wanted.filter((document) => indexed.get(document.path)?.blob !== document.blob).length;
  for (const document of wanted) {
    const before = indexed.get(document.path);
    if (before?.blob === document.blob) {
      if (before.scope !== document.scope) rescoped.push(document);
      continue;
    }
    const text = await readTextAt(git, vault.path, sha, document.path);
    if (!text.ok) return text;
    prepared.push({ ...document, ...chunkDocument(vault.id, document.path, text.value ?? '') });
    onProgress?.({ vault: vault.id, phase: 'reading', done: prepared.length, total: toRead });
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
    vectors: await addVectors(context, vault, sha, onProgress),
  });
}

/** The vault's indexed documents with a chunk that has no vector, by path; empty without the vector extension. */
export function documentsWithoutVectors(index: Store, vault: string): string[] {
  if (!index.vectors) return [];
  return index.all<{ path: string }>(
    `SELECT DISTINCT c.path FROM search_chunks c LEFT JOIN search_vectors v ON v.chunk = c.id
     WHERE c.vault = ? AND v.chunk IS NULL ORDER BY c.path`,
    [vault],
  ).map((row) => row.path);
}
