// The only access to the package's SQLite files (`state.sqlite`, `index.sqlite`).
// `node:sqlite` is a release-candidate API, so it is imported nowhere else: a
// change of driver touches this module only. The same holds for `sqlite-vec`,
// the extension that gives the index its vector functions.
//
// Store knows no other module's tables. Each module owns the migrations for its
// own tables and hands them in (the operations layer assembles the full list
// per file); store records the version each module has reached and applies
// what is pending.
//
// Invariants:
//  - every multi-step write is one `BEGIN IMMEDIATE` transaction, so the write
//    lock is taken up front and a second writer waits (busy timeout) or fails
//    cleanly instead of deadlocking mid-transaction;
//  - write-ahead logging, with the durability the file's lifecycle calls for;
//  - migrations run on open inside one transaction, with versions re-read under
//    the write lock so concurrent openers apply each migration once; a file in
//    which any module — or store's own bookkeeping — is newer than this code
//    knows is refused, and so is a module this code does not know at all;
//  - a module's migrations create, change and drop only objects named
//    `<module>_…` on its own tables, so ownership is checked, not assumed;
//  - files are created readable by the user only (the -wal and -shm companions
//    inherit the main file's mode);
//  - only a file that asks for vectors loads an extension, and only sqlite-vec;
//    loading is switched off again before any statement runs, so SQL can never
//    load one. An extension that cannot be loaded leaves the file open without
//    vectors (`vectors: false`), so search degrades instead of failing.

import { closeSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
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
  /** The schema version each module given to `openStore` is at. */
  readonly versions: Readonly<Record<string, number>>;
  /** Whether sqlite-vec's vector functions are available. */
  readonly vectors: boolean;
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

/** The tables one module keeps in one file: an append-only list of migrations, versions 1, 2, 3, … */
export interface ModuleSchema {
  /** The owning module; every object its migrations create is named `<module>_…`. */
  readonly module: string;
  readonly migrations: readonly Migration[];
}

/** What a file's lifecycle asks of SQLite, independent of the modules that keep tables in it. */
export interface StoreFile {
  /** FULL for durable state; NORMAL for a rebuildable index. */
  readonly synchronous: 'FULL' | 'NORMAL';
  /** Load sqlite-vec for vector search. */
  readonly vectors?: boolean;
}

export const STATE_FILE: StoreFile = { synchronous: 'FULL' };
export const INDEX_FILE: StoreFile = { synchronous: 'NORMAL', vectors: true };

export type StoreError =
  /** `module` is `store` when the file's own bookkeeping is from a newer version. */
  | { readonly reason: 'schema-too-new'; readonly module: string; readonly found: number; readonly supported: number }
  | { readonly reason: 'unavailable'; readonly code: string };

export interface StoreOptions {
  readonly busyTimeoutMs?: number;
  /** The sqlite-vec library to load; defaults to the one installed for this platform. */
  readonly vectorExtension?: string;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Store's own bookkeeping: `user_version` holds its format, and format 1 is a
 * `store_versions` table with one row per module. The name `store` is reserved.
 */
const STORE_MODULE = 'store';
const STORE_FORMAT = 1;
const STORE_FORMAT_1 = 'CREATE TABLE store_versions (module TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT';
/** One lower-case word, so `<module>_` is an unambiguous prefix. */
const MODULE_NAME = /^[a-z][a-z0-9]*$/;

function assertWellFormed(modules: readonly ModuleSchema[]): void {
  const seen = new Set<string>();
  for (const { module, migrations } of modules) {
    if (!MODULE_NAME.test(module) || module === STORE_MODULE) throw new Error(`invalid module name "${module}"`);
    if (seen.has(module)) throw new Error(`module "${module}" is given twice`);
    seen.add(module);
    migrations.forEach((m, i) => {
      if (m.version !== i + 1) {
        throw new Error(`${module} migrations must be contiguous from 1; got version ${m.version} at position ${i + 1}`);
      }
    });
  }
}

/** Loads sqlite-vec, then switches extension loading off for good; false when it cannot be loaded. */
function loadVectors(db: DatabaseSync, path: string | undefined): boolean {
  try {
    db.loadExtension(path ?? getLoadablePath());
    return true;
  } catch {
    return false; // no build for this platform, or not installed
  } finally {
    db.enableLoadExtension(false);
  }
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

type SchemaObjects = Map<string, { readonly table: string; readonly sql: string | null }>;

function schemaObjects(db: DatabaseSync): SchemaObjects {
  const rows = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all();
  return new Map(rows.map((row) => [String(row['name']), { table: String(row['tbl_name']), sql: row['sql'] as string | null }]));
}

/** Throws unless every object created, changed or dropped between the snapshots is the module's own. */
function assertOwnChanges(module: string, before: SchemaObjects, after: SchemaObjects): void {
  const prefix = `${module}_`;
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name);
    const is = after.get(name);
    if (was?.sql === is?.sql && was?.table === is?.table) continue;
    const table = (is ?? was)?.table ?? name;
    if (!name.startsWith(prefix) || !table.startsWith(prefix)) {
      throw new Error(`${module} migrations may only change objects named ${prefix}… on its own tables; they changed "${name}"`);
    }
  }
}

/**
 * Applies pending migrations under the write lock. Returns each module's
 * resulting version, or the first module found newer than this code supports;
 * a refusal changes nothing.
 */
function migrate(db: DatabaseSync, modules: readonly ModuleSchema[]): Result<Record<string, number>, StoreError> {
  db.exec('BEGIN IMMEDIATE');
  try {
    const refuse = (module: string, found: number, supported: number): Result<never, StoreError> => {
      db.exec('ROLLBACK');
      return err({ reason: 'schema-too-new', module, found, supported });
    };
    const format = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (format > STORE_FORMAT) return refuse(STORE_MODULE, format, STORE_FORMAT);
    if (format === 0) {
      db.exec(STORE_FORMAT_1);
      db.exec(`PRAGMA user_version = ${STORE_FORMAT}`);
    }

    const recorded = new Map(
      db.prepare('SELECT module, version FROM store_versions').all().map((row) => [String(row['module']), Number(row['version'])]),
    );
    const given = new Map(modules.map((m) => [m.module, m.migrations.length]));
    for (const [module, found] of recorded) {
      const supported = given.get(module) ?? 0;
      if (found > supported) return refuse(module, found, supported);
    }

    const record = db.prepare('INSERT INTO store_versions (module, version) VALUES (?, ?) ON CONFLICT (module) DO UPDATE SET version = excluded.version');
    const versions: Record<string, number> = {};
    for (const { module, migrations } of modules) {
      const pending = migrations.slice(recorded.get(module) ?? 0);
      if (pending.length > 0) {
        const before = schemaObjects(db);
        for (const migration of pending) db.exec(migration.sql);
        assertOwnChanges(module, before, schemaObjects(db));
        record.run(module, migrations.length);
      }
      versions[module] = migrations.length;
    }
    db.exec('COMMIT');
    return ok(versions);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opens (creating if needed) the file at `path` with the tables of the given
 * modules. Every opener of a file must pass the same, complete list: a module
 * recorded in the file but not given is treated as newer than this code.
 */
export function openStore(path: string, file: StoreFile, modules: readonly ModuleSchema[], options: StoreOptions = {}): Result<Store, StoreError> {
  assertWellFormed(modules);
  let db: DatabaseSync;
  try {
    ensurePrivateDir(dirname(path));
    createPrivateFile(path);
    db = new DatabaseSync(path, { allowExtension: file.vectors === true });
  } catch (error) {
    return err({ reason: 'unavailable', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' });
  }

  const vectors = file.vectors === true && loadVectors(db, options.vectorExtension);
  let versions: Record<string, number>;
  try {
    // The timeout comes first so every later statement waits for a busy file.
    db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA synchronous = ${file.synchronous}`);
    db.exec('PRAGMA foreign_keys = ON');
    const migrated = migrate(db, modules);
    if (!migrated.ok) {
      db.close();
      return migrated;
    }
    versions = migrated.value;
  } catch (error) {
    db.close();
    throw error;
  }

  const base = queryable(db);
  let inTransaction = false;
  return ok({
    ...base,
    versions,
    vectors,
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
