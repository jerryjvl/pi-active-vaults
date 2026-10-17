// The search index's tables in `index.sqlite` (architecture.md "Local
// storage"): documents with the blob each was indexed at, their chunks, a
// keyword index (FTS5) kept in step with the chunks by triggers, vectors, and
// the embedding model the vectors were made with. The index is derived from
// Git and disposable.
//
// Vectors are ordinary rows ranked with sqlite-vec's distance function rather
// than a virtual table, so the schema does not need the extension: where it
// cannot be loaded the index still opens and keyword search works.

import type { ModuleSchema } from '../store/index.ts';

export const searchSchema: ModuleSchema = {
  module: 'search',
  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE search_vaults (vault TEXT PRIMARY KEY, sha TEXT NOT NULL, updated TEXT NOT NULL) STRICT;
      CREATE TABLE search_documents (
        vault TEXT NOT NULL,
        path TEXT NOT NULL,
        blob TEXT NOT NULL,
        title TEXT NOT NULL,
        scope TEXT NOT NULL,
        PRIMARY KEY (vault, path)
      ) STRICT;
      CREATE TABLE search_chunks (
        id INTEGER PRIMARY KEY,
        vault TEXT NOT NULL,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading TEXT NOT NULL,
        header TEXT NOT NULL,
        body TEXT NOT NULL
      ) STRICT;
      CREATE INDEX search_chunks_by_document ON search_chunks (vault, path);
      CREATE TABLE search_vectors (chunk INTEGER PRIMARY KEY, embedding BLOB NOT NULL) STRICT;
      CREATE VIRTUAL TABLE search_fts USING fts5(header, body, content = 'search_chunks', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2');
      CREATE TRIGGER search_chunks_indexed AFTER INSERT ON search_chunks BEGIN
        INSERT INTO search_fts (rowid, header, body) VALUES (new.id, new.header, new.body);
      END;
      CREATE TRIGGER search_chunks_removed AFTER DELETE ON search_chunks BEGIN
        INSERT INTO search_fts (search_fts, rowid, header, body) VALUES ('delete', old.id, old.header, old.body);
        DELETE FROM search_vectors WHERE chunk = old.id;
      END`,
    },
  ],
};

/** The `search_meta` key recording the embedding model the vectors were made with. */
export const EMBEDDING_MODEL_KEY = 'embedding-model';
