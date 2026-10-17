// The only access to the package's SQLite files (`state.sqlite`, `index.sqlite`).
// `node:sqlite` is a release-candidate API, so it is imported nowhere else: a
// change of driver touches this module only.
//
// Invariants:
//  - every multi-step write is one `BEGIN IMMEDIATE` transaction, so the write
//    lock is taken up front and a second writer waits (busy timeout) or fails
//    cleanly instead of deadlocking mid-transaction;
//  - write-ahead logging, with the durability the file's lifecycle calls for;
//  - the schema version is stored in `user_version` and migrated forward on
//    open inside one transaction, re-read under the write lock so concurrent
//    openers apply each migration once; a file from a newer schema is refused;
//  - files are created readable by the user only (the -wal and -shm companions
//    inherit the main file's mode).

import { closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ensurePrivateDir } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
export type Row = Record<string, unknown>;

export interface Queryable {
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint };
  get<T extends object = Row>(sql: string, params?: SqlParams): T | undefined;
  all<T extends object = Row>(sql: string, params?: SqlParams): T[];
}

export interface Store extends Queryable {
  readonly schemaVersion: number;
  /**
   * Runs `fn` in a `BEGIN IMMEDIATE` transaction: commits when it returns,
   * rolls back and rethrows when it throws. `fn` must be synchronous and
   * transactions do not nest; either is a programming error.
   */
  transaction<T>(fn: (tx: Queryable) => T): T;
  close(): void;
}

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export interface StoreSchema {
  readonly name: string;
  /** FULL for durable state; NORMAL for a rebuildable index. */
  readonly synchronous: 'FULL' | 'NORMAL';
  readonly migrations: readonly Migration[];
}

export type StoreError =
  | { readonly reason: 'schema-too-new'; readonly found: number; readonly supported: number }
  | { readonly reason: 'unavailable'; readonly code: string };

export interface StoreOptions {
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Schemas are append-only lists owned here, in one place, because each file is
 * shared by several modules and `user_version` is a single linear history.
 * Later stages add their tables as new migrations.
 */
export const stateSchema: StoreSchema = { name: 'state', synchronous: 'FULL', migrations: [] };
export const indexSchema: StoreSchema = { name: 'index', synchronous: 'NORMAL', migrations: [] };

function assertContiguous(schema: StoreSchema): void {
  schema.migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`${schema.name} migrations must be contiguous from 1; got version ${m.version} at position ${i + 1}`);
    }
  });
}

/** Creates the file with mode 0600 before SQLite sees it; SQLite would use the umask. */
function createPrivateFile(path: string): void {
  closeSync(openSync(path, 'a', 0o600));
}

/** The driver returns rows with a null prototype; callers get ordinary objects. */
function plain(row: object): Row {
  return { ...row };
}

function queryable(db: DatabaseSync): Queryable {
  const cache = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let found = cache.get(sql);
    if (found === undefined) {
      found = db.prepare(sql);
      cache.set(sql, found);
    }
    return found;
  };
  // Positional parameters spread; a named-parameter object is passed whole.
  const bind = (params: SqlParams | undefined): Parameters<StatementSync['run']> =>
    (params === undefined ? [] : Array.isArray(params) ? [...params] : [params]) as Parameters<StatementSync['run']>;
  return {
    run: (sql, params) => {
      const { changes, lastInsertRowid } = statement(sql).run(...bind(params));
      return { changes: Number(changes), lastInsertRowid };
    },
    get: <T extends object = Row>(sql: string, params?: SqlParams) => {
      const row = statement(sql).get(...bind(params));
      return row === undefined ? undefined : (plain(row) as T);
    },
    all: <T extends object = Row>(sql: string, params?: SqlParams) =>
      statement(sql).all(...bind(params)).map((row) => plain(row) as T),
  };
}

/** Applies pending migrations under the write lock; returns the resulting version or the newer version found. */
function migrate(db: DatabaseSync, schema: StoreSchema): Result<number, StoreError> {
  const latest = schema.migrations.length;
  db.exec('BEGIN IMMEDIATE');
  try {
    const found = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (found > latest) {
      db.exec('ROLLBACK');
      return err({ reason: 'schema-too-new', found, supported: latest });
    }
    for (const migration of schema.migrations.slice(found)) {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec('COMMIT');
    return ok(latest);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openStore(path: string, schema: StoreSchema, options: StoreOptions = {}): Result<Store, StoreError> {
  assertContiguous(schema);
  let db: DatabaseSync;
  try {
    ensurePrivateDir(dirname(path));
    createPrivateFile(path);
    db = new DatabaseSync(path);
  } catch (error) {
    return err({ reason: 'unavailable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
  }

  let version: number;
  try {
    // The timeout comes first so every later statement waits for a busy file.
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${schema.synchronous}`);
    db.exec('PRAGMA foreign_keys = ON');
    const migrated = migrate(db, schema);
    if (!migrated.ok) {
      db.close();
      return migrated;
    }
    version = migrated.value;
  } catch (error) {
    db.close();
    throw error;
  }

  const base = queryable(db);
  let inTransaction = false;
  return ok({
    ...base,
    schemaVersion: version,
    transaction<T>(fn: (tx: Queryable) => T): T {
      if (inTransaction) throw new Error('nested transactions are not supported');
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = fn(base);
        if (typeof (result as { then?: unknown } | null)?.then === 'function') {
          throw new Error('transaction callbacks must be synchronous: an async callback would commit before it finishes');
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      if (db.isOpen) db.close();
    },
  });
}

export function openStateStore(paths: { stateDb: string }, options?: StoreOptions): Result<Store, StoreError> {
  return openStore(paths.stateDb, stateSchema, options);
}

export function openIndexStore(paths: { indexDb: string }, options?: StoreOptions): Result<Store, StoreError> {
  return openStore(paths.indexDb, indexSchema, options);
}
