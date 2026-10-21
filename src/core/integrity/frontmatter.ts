// The frontmatter of every document at a commit (architecture.md "Reads from
// the accepted main"): what conditions, jobs and injection are found from, so
// it is read for a whole tree — on every surface's first event, and again for
// each newly accepted main.
//
// Two things keep that affordable. The tree is listed once and its documents
// read together (`readBlobs`), never one process per file. And the parsed
// frontmatter is kept in `index.sqlite`, by vault, path and blob, so a new
// accepted main — or a new process — parses only the documents whose content
// changed.
//
// Invariants:
//  - a cached value is used only for the exact blob it was parsed from: a blob
//    is named by the hash of its content, so a hit is the same content, and a
//    row left by another process at another commit can only miss, never be
//    wrong;
//  - only what survives a JSON round trip unchanged is cached: a value JSON
//    cannot hold (`.inf`, `-0`) is parsed afresh each time rather than stored
//    as something else;
//  - the cache is derived and disposable: a store that cannot be opened,
//    read or written makes the scan read everything, never fail;
//  - `FRONTMATTER_FORMAT` names what the parse produces; rows of another
//    format are misses.

import { isDeepStrictEqual } from 'node:util';
import { isDocumentPath, parseDocument, type DocumentError } from '../documents/index.ts';
import { listTree, readBlobs, type Git, type GitError, type Sha } from '../git/index.ts';
import { isRecord, ok, type Result } from '../result/index.ts';
import type { ModuleSchema, Store } from '../store/index.ts';

export type CommittedFrontmatter =
  | { readonly state: 'unreadable'; readonly error: DocumentError }
  | { readonly state: 'read'; readonly frontmatter: Readonly<Record<string, unknown>> };

/** Bump when `parseDocument` (or the YAML library) would read the same text as different frontmatter. */
const FRONTMATTER_FORMAT = 1;

export const readsSchema: ModuleSchema = {
  module: 'reads',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE reads_frontmatter (
        vault TEXT NOT NULL,
        path TEXT NOT NULL,
        blob TEXT NOT NULL,
        format INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (vault, path)
      ) STRICT`,
    },
  ],
};

/** A document's parsed frontmatter, and the blob it was parsed from. */
export interface HeldFrontmatter {
  readonly blob: Sha;
  readonly value: CommittedFrontmatter;
}

/** Parsed frontmatter kept across processes, by vault and path. */
export interface FrontmatterCache {
  /** The vault's cached documents, by path. */
  held(vault: string): ReadonlyMap<string, HeldFrontmatter>;
  /** Keeps newly parsed documents and forgets paths the vault no longer has, together. */
  update(vault: string, parsed: ReadonlyMap<string, HeldFrontmatter>, gone: readonly string[]): void;
}

/** The value as JSON when JSON gives it back unchanged; otherwise undefined, and it is not kept. */
function storable(value: CommittedFrontmatter): string | undefined {
  const json = JSON.stringify(value);
  return isDeepStrictEqual(JSON.parse(json), value) ? json : undefined;
}

/** A row's value, when it is one this cache writes. */
function parsedRow(json: string): CommittedFrontmatter | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value['state'] === 'read' && isRecord(value['frontmatter'])) return value as CommittedFrontmatter;
  if (value['state'] === 'unreadable' && isRecord(value['error'])) return value as CommittedFrontmatter;
  return undefined;
}

/**
 * A cache in the given store, opened when first needed. The store's failures
 * (it cannot be opened, a statement fails, a row is not JSON) are not the
 * scan's: what cannot be read is a miss, and what cannot be written is parsed
 * again next time.
 */
export function frontmatterCache(store: () => Store | undefined): FrontmatterCache {
  return {
    held(vault) {
      let rows: { path: string; blob: string; value: string }[];
      try {
        rows = store()?.all('SELECT path, blob, value FROM reads_frontmatter WHERE vault = ? AND format = ?', [vault, FRONTMATTER_FORMAT]) ?? [];
      } catch {
        return new Map();
      }
      const held = new Map<string, HeldFrontmatter>();
      for (const { path, blob, value } of rows) {
        const read = parsedRow(value);
        // Otherwise a miss: the document is parsed again and the row replaced.
        if (read !== undefined) held.set(path, { blob, value: read });
      }
      return held;
    },
    update(vault, parsed, gone) {
      const rows = [...parsed].flatMap(([path, { blob, value }]) => {
        const json = storable(value);
        return json === undefined ? [] : [[vault, path, blob, FRONTMATTER_FORMAT, json] as const];
      });
      if (rows.length === 0 && gone.length === 0) return;
      try {
        store()?.transaction((tx) => {
          for (const path of gone) tx.run('DELETE FROM reads_frontmatter WHERE vault = ? AND path = ?', [vault, path]);
          for (const row of rows) {
            tx.run(
              `INSERT INTO reads_frontmatter (vault, path, blob, format, value) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (vault, path) DO UPDATE SET blob = excluded.blob, format = excluded.format, value = excluded.value`,
              row,
            );
          }
        });
      } catch {
        // Not kept this time; the next scan parses these again.
      }
    },
  };
}

function frontmatterOf(text: string): CommittedFrontmatter {
  const parsed = parseDocument(text);
  return parsed.ok ? { state: 'read', frontmatter: parsed.value.frontmatter } : { state: 'unreadable', error: parsed.error };
}

/** The frontmatter of every document in the commit's tree, by path in tree order; `cache` spares re-parsing unchanged content. */
export async function scanFrontmatter(
  git: Git, repo: string, vault: string, sha: Sha, cache?: FrontmatterCache,
): Promise<Result<Map<string, CommittedFrontmatter>, GitError>> {
  const tree = await listTree(git, repo, sha);
  if (!tree.ok) return tree;
  const documents = tree.value.filter((entry) => isDocumentPath(entry.path));
  const held = cache?.held(vault) ?? new Map<string, HeldFrontmatter>();
  const missed = documents.filter((entry) => held.get(entry.path)?.blob !== entry.sha);
  const blobs = await readBlobs(git, repo, missed);
  if (!blobs.ok) return blobs;
  const parsed = new Map(missed.map(({ path, sha: blob }) => [path, { blob, value: frontmatterOf(blobs.value.get(blob)?.toString('utf8') ?? '') }]));
  const present = new Set(documents.map((entry) => entry.path));
  cache?.update(vault, parsed, [...held.keys()].filter((path) => !present.has(path)));
  return ok(new Map(documents.map(({ path }) => [path, (parsed.get(path) ?? held.get(path))?.value as CommittedFrontmatter])));
}
