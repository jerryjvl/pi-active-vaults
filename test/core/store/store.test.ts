// Documented behaviour: architecture.md "Local storage" — one access path,
// atomic BEGIN IMMEDIATE transactions, WAL with per-file durability, a busy
// timeout, schemas versioned per module and migrated forward on open (a file
// from a newer version of any module is refused), files private to the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import {
  INDEX_FILE,
  STATE_FILE,
  openStore,
  type Migration,
  type ModuleSchema,
  type Store,
} from '../../../src/core/store/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const ALPHA_V1: Migration = { version: 1, sql: 'CREATE TABLE alpha_claims (spawn TEXT PRIMARY KEY, owner TEXT NOT NULL)' };
const ALPHA_V2: Migration = { version: 2, sql: 'CREATE TABLE alpha_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)' };
const alpha = (...migrations: Migration[]): ModuleSchema => ({ module: 'alpha', migrations });
const beta: ModuleSchema = { module: 'beta', migrations: [{ version: 1, sql: 'CREATE TABLE beta_items (id INTEGER PRIMARY KEY)' }] };
const BOTH = [alpha(ALPHA_V1, ALPHA_V2), beta];

function open(path: string, modules: readonly ModuleSchema[] = BOTH, options = {}): Store {
  const result = openStore(path, STATE_FILE, modules, options);
  if (!result.ok) assert.fail(`open failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const tables = (store: Store): string[] =>
  store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name);

test('a new store gets each module\'s tables and records the version each module reached', withTempDir((dir) => {
  const store = open(dir.file('data', 'state.sqlite'));
  assert.deepEqual(store.versions, { alpha: 2, beta: 1 });
  assert.deepEqual(tables(store), ['alpha_claims', 'alpha_notes', 'beta_items', 'store_versions']);
  store.close();
}));

test('reopening applies only what each module is missing, and a newly added module starts from its first migration', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  const first = open(path, [alpha(ALPHA_V1)]);
  first.run("INSERT INTO alpha_claims VALUES ('a', 'me')");
  first.close();
  const second = open(path);
  assert.deepEqual(second.versions, { alpha: 2, beta: 1 });
  assert.equal(second.get('SELECT owner FROM alpha_claims WHERE spawn = ?', ['a'])?.['owner'], 'me', 'data survives migration');
  second.close();
}));

test('two connections opening the same new file apply each migration exactly once', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  const a = open(path);
  const b = open(path); // would fail on "table already exists" if it re-ran a migration
  assert.deepEqual(b.versions, { alpha: 2, beta: 1 });
  a.close();
  b.close();
}));

test('a file where any module is newer than this version supports is refused, and left unchanged', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  open(path).close();
  const result = openStore(path, STATE_FILE, [alpha(ALPHA_V1), beta]);
  assert.deepEqual(result, { ok: false, error: { reason: 'schema-too-new', module: 'alpha', found: 2, supported: 1 } });
  open(path).close();
}));

test('a file holding tables of a module this version does not know is refused as newer', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  open(path).close();
  const result = openStore(path, STATE_FILE, [alpha(ALPHA_V1, ALPHA_V2)]);
  assert.deepEqual(result, { ok: false, error: { reason: 'schema-too-new', module: 'beta', found: 1, supported: 0 } });
}));

test('a file whose own bookkeeping format is newer is refused', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  const store = open(path);
  store.run('PRAGMA user_version = 99');
  store.close();
  const result = openStore(path, STATE_FILE, BOTH);
  assert.deepEqual(result, { ok: false, error: { reason: 'schema-too-new', module: 'store', found: 99, supported: 1 } });
}));

test('a failing migration rolls back every module\'s changes and leaves the versions unchanged', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  open(path, [alpha(ALPHA_V1)]).close();
  const broken: ModuleSchema = { module: 'gamma', migrations: [{ version: 1, sql: 'CREATE TABLE gamma_half (x); THIS IS NOT SQL' }] };
  assert.throws(() => openStore(path, STATE_FILE, [alpha(ALPHA_V1, ALPHA_V2), beta, broken]));
  const after = open(path, [alpha(ALPHA_V1)]);
  assert.deepEqual(after.versions, { alpha: 1 });
  assert.deepEqual(tables(after), ['alpha_claims', 'store_versions']);
  after.close();
}));

test('migrations that skip or repeat a version are a programming error', withTempDir((dir) => {
  const gap = alpha(ALPHA_V1, { version: 3, sql: 'SELECT 1' });
  assert.throws(() => openStore(dir.file('a.sqlite'), STATE_FILE, [gap]), /contiguous/);
  assert.throws(() => openStore(dir.file('b.sqlite'), STATE_FILE, [alpha({ version: 2, sql: 'SELECT 1' })]), /contiguous/);
}));

test('module names are unique, lower-case words, and "store" is reserved', withTempDir((dir) => {
  for (const modules of [[beta, beta], [{ ...beta, module: 'Beta' }], [{ ...beta, module: 'be_ta' }], [{ ...beta, module: 'store' }]]) {
    assert.throws(() => openStore(dir.file('s.sqlite'), STATE_FILE, modules), /module/, JSON.stringify(modules.map((m) => m.module)));
  }
}));

test('a module may create and drop only objects named after it, so no module holds another\'s tables', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  const unprefixed = alpha({ version: 1, sql: 'CREATE TABLE claims (x)' });
  const foreign = alpha({ version: 1, sql: 'CREATE TABLE beta_stolen (x)' });
  const foreignIndex = { module: 'gamma', migrations: [{ version: 1, sql: 'CREATE INDEX gamma_idx ON beta_items (id)' }] };
  assert.throws(() => openStore(path, STATE_FILE, [unprefixed]), /alpha_/);
  assert.throws(() => openStore(path, STATE_FILE, [foreign]), /alpha_/);
  open(path, [beta]).close();
  // An index on another module's table is named after its creator, but its
  // table is not: still refused, because it changes what the other module owns.
  assert.throws(() => openStore(path, STATE_FILE, [beta, foreignIndex]), /gamma/);
  const dropper = { module: 'gamma', migrations: [{ version: 1, sql: 'DROP TABLE beta_items' }] };
  assert.throws(() => openStore(path, STATE_FILE, [beta, dropper]), /gamma/);
  const store = open(path, [beta]);
  assert.deepEqual(tables(store), ['beta_items', 'store_versions']);
  store.close();
}));

test('a transaction commits everything or nothing', withTempDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  const result = store.transaction((tx) => {
    tx.run("INSERT INTO alpha_claims VALUES ('a', 'me')");
    tx.run("INSERT INTO alpha_notes (body) VALUES ('hello')");
    return 'done';
  });
  assert.equal(result, 'done');
  assert.throws(() =>
    store.transaction((tx) => {
      tx.run("INSERT INTO alpha_claims VALUES ('b', 'me')");
      throw new Error('boom');
    }),
  /boom/);
  assert.deepEqual(store.all('SELECT spawn FROM alpha_claims'), [{ spawn: 'a' }]);
  store.close();
}));

test('transactions take the write lock when they begin, so a second writer waits or fails fast', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  const a = open(path);
  const b = open(path, BOTH, { busyTimeoutMs: 20 });
  a.transaction(() => {
    assert.throws(() => b.transaction((tx) => tx.run("INSERT INTO alpha_claims VALUES ('x', 'b')")), /locked|busy/i);
    // Readers are not blocked by a writer (write-ahead logging).
    assert.deepEqual(b.all('SELECT * FROM alpha_claims'), []);
  });
  b.transaction((tx) => tx.run("INSERT INTO alpha_claims VALUES ('x', 'b')"));
  a.close();
  b.close();
}));

test('a claim is a unique insert: the second claim for the same spawn changes nothing', withTempDir((dir) => {
  const path = dir.file('s.sqlite');
  const a = open(path);
  const b = open(path);
  const claim = (store: Store, owner: string) =>
    store.transaction((tx) => tx.run('INSERT INTO alpha_claims VALUES (?, ?) ON CONFLICT DO NOTHING', ['spawn-1', owner]).changes);
  assert.equal(claim(a, 'daemon'), 1);
  assert.equal(claim(b, 'cli'), 0);
  assert.equal(a.get('SELECT owner FROM alpha_claims')?.['owner'], 'daemon');
  a.close();
  b.close();
}));

test('transactions do not nest, and an async callback is refused because it would commit early', withTempDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  assert.throws(() => store.transaction(() => store.transaction(() => 1)), /nested/i);
  assert.throws(() => store.transaction(async () => 1), /synchronous/i);
  // The refused transaction was rolled back, so the store is usable again.
  assert.equal(store.transaction(() => 1), 1);
  store.close();
}));

test('named parameters round-trip', withTempDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  store.run('INSERT INTO alpha_claims VALUES ($spawn, $owner)', { spawn: 's', owner: 'o' });
  assert.equal(store.get('SELECT owner FROM alpha_claims WHERE spawn = $spawn', { spawn: 's' })?.['owner'], 'o');
  store.close();
}));

test('state and index follow their documented durability and journal settings', withTempDir((dir) => {
  const opened = (name: string, file: typeof STATE_FILE): Store => {
    const result = openStore(dir.file(name), file, []);
    if (!result.ok) assert.fail(JSON.stringify(result.error));
    return result.value;
  };
  const state = opened('state.sqlite', STATE_FILE);
  const index = opened('index.sqlite', INDEX_FILE);
  const pragma = (s: Store, name: string) => Object.values(s.get(`PRAGMA ${name}`) ?? {})[0];
  assert.equal(pragma(state, 'journal_mode'), 'wal');
  assert.equal(pragma(index, 'journal_mode'), 'wal');
  assert.equal(pragma(state, 'synchronous'), 2, 'FULL');
  assert.equal(pragma(index, 'synchronous'), 1, 'NORMAL');
  assert.equal(pragma(state, 'foreign_keys'), 1);
  assert.ok(Number(pragma(state, 'busy_timeout')) > 0);
  state.close();
  index.close();
}));

test('database files are created accessible to the user only (POSIX modes)', { skip: process.platform === 'win32' }, withTempDir((dir) => {
  const path = dir.file('private', 'state.sqlite');
  const store = open(path);
  store.run("INSERT INTO alpha_claims VALUES ('a', 'me')"); // creates the -wal and -shm files
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir.file('private')).mode & 0o777, 0o700);
  for (const suffix of ['-wal', '-shm']) assert.equal(statSync(path + suffix).mode & 0o077, 0, suffix);
  store.close();
}));

test('an unusable location is reported as a value, not thrown', withTempDir((dir) => {
  const result = openStore(dir.path, STATE_FILE, BOTH); // a directory is not a database file
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, 'unavailable');
}));

test('closing is idempotent and a closed store cannot be used', withTempDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  store.close();
  store.close();
  assert.throws(() => store.all('SELECT 1'));
}));

// Documented behaviour: architecture.md "Technology" — sqlite-vec is loaded as
// a SQLite extension for vector search, in the index file; without it the
// index still opens (search degrades to keywords).
test('the index file loads the vector extension, and SQL can load no other', withTempDir((dir) => {
  const opened = openStore(dir.file('index.sqlite'), INDEX_FILE, []);
  if (!opened.ok) assert.fail(JSON.stringify(opened.error));
  const store = opened.value;
  try {
    assert.equal(store.vectors, true);
    assert.match(String(store.get<{ v: string }>('SELECT vec_version() AS v')?.v), /^v\d/);
    assert.throws(() => store.get("SELECT load_extension('/nonexistent/evil')"), /not authorized/);
  } finally {
    store.close();
  }
}));

test('the state file loads no extension', withTempDir((dir) => {
  const store = open(dir.file('state.sqlite'), []);
  try {
    assert.equal(store.vectors, false);
    assert.throws(() => store.get('SELECT vec_version()'), /no such function/);
  } finally {
    store.close();
  }
}));

test('an index whose vector extension cannot be loaded still opens, without vectors', withTempDir((dir) => {
  const opened = openStore(dir.file('index.sqlite'), INDEX_FILE, [], { vectorExtension: dir.file('missing.so') });
  if (!opened.ok) assert.fail(JSON.stringify(opened.error));
  try {
    assert.equal(opened.value.vectors, false);
    assert.throws(() => opened.value.get('SELECT vec_version()'), /no such function/);
  } finally {
    opened.value.close();
  }
}));
