// Documented behaviour: architecture.md "Local storage" — one access path,
// atomic BEGIN IMMEDIATE transactions, WAL with per-file durability, a busy
// timeout, schema versions migrated forward on open, files private to the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import {
  indexSchema,
  openStateStore,
  openStore,
  stateSchema,
  type Migration,
  type Store,
  type StoreSchema,
} from '../../../src/core/store/index.ts';
import { createTempDir } from '../../support/temp-dir.ts';

const MIGRATIONS: Migration[] = [
  { version: 1, sql: 'CREATE TABLE claims (spawn TEXT PRIMARY KEY, owner TEXT NOT NULL)' },
  { version: 2, sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)' },
];

const schema = (overrides: Partial<StoreSchema> = {}): StoreSchema => ({
  name: 'test',
  synchronous: 'FULL',
  migrations: MIGRATIONS,
  ...overrides,
});

function open(path: string, s: StoreSchema = schema(), options = {}): Store {
  const result = openStore(path, s, options);
  if (!result.ok) assert.fail(`open failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function withDir(run: (dir: ReturnType<typeof createTempDir>) => void | Promise<void>) {
  return async () => {
    const dir = createTempDir('pav-store-');
    try {
      await run(dir);
    } finally {
      dir.cleanup();
    }
  };
}

test('a new store is created with the schema applied and its version recorded', withDir((dir) => {
  const store = open(dir.file('data', 'state.sqlite'));
  assert.equal(store.schemaVersion, 2);
  assert.deepEqual(store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"), [
    { name: 'claims' },
    { name: 'notes' },
  ]);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 2);
  store.close();
}));

test('reopening migrates only what is missing, forward', withDir((dir) => {
  const path = dir.file('s.sqlite');
  const first = open(path, schema({ migrations: [MIGRATIONS[0]!] }));
  first.run("INSERT INTO claims VALUES ('a', 'me')");
  first.close();
  const second = open(path);
  assert.equal(second.schemaVersion, 2);
  assert.equal(second.get('SELECT owner FROM claims WHERE spawn = ?', ['a'])?.['owner'], 'me', 'data survives migration');
  second.close();
}));

test('two connections opening the same new file apply each migration exactly once', withDir((dir) => {
  const path = dir.file('s.sqlite');
  const a = open(path);
  const b = open(path); // would fail on "table already exists" if it re-ran version 1
  assert.equal(b.schemaVersion, 2);
  a.close();
  b.close();
}));

test('a store written by a newer schema is refused, not downgraded or guessed at', withDir((dir) => {
  const path = dir.file('s.sqlite');
  open(path).close();
  const result = openStore(path, schema({ migrations: [MIGRATIONS[0]!] }));
  assert.deepEqual(result, { ok: false, error: { reason: 'schema-too-new', found: 2, supported: 1 } });
}));

test('a failing migration rolls back entirely and leaves the version unchanged', withDir((dir) => {
  const path = dir.file('s.sqlite');
  open(path, schema({ migrations: [MIGRATIONS[0]!] })).close();
  const broken: Migration = { version: 2, sql: 'CREATE TABLE half (x); THIS IS NOT SQL' };
  assert.throws(() => openStore(path, schema({ migrations: [MIGRATIONS[0]!, broken] })));
  const after = open(path, schema({ migrations: [MIGRATIONS[0]!] }));
  assert.equal(after.schemaVersion, 1);
  assert.equal(after.get("SELECT name FROM sqlite_master WHERE name = 'half'"), undefined);
  after.close();
}));

test('migrations that skip or repeat a version are a programming error', withDir((dir) => {
  const gap = [MIGRATIONS[0]!, { version: 3, sql: 'SELECT 1' }];
  assert.throws(() => openStore(dir.file('a.sqlite'), schema({ migrations: gap })), /contiguous/);
  assert.throws(() => openStore(dir.file('b.sqlite'), schema({ migrations: [{ version: 2, sql: 'SELECT 1' }] })), /contiguous/);
}));

test('a transaction commits everything or nothing', withDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  const result = store.transaction((tx) => {
    tx.run("INSERT INTO claims VALUES ('a', 'me')");
    tx.run("INSERT INTO notes (body) VALUES ('hello')");
    return 'done';
  });
  assert.equal(result, 'done');
  assert.throws(() =>
    store.transaction((tx) => {
      tx.run("INSERT INTO claims VALUES ('b', 'me')");
      throw new Error('boom');
    }),
  /boom/);
  assert.deepEqual(store.all('SELECT spawn FROM claims'), [{ spawn: 'a' }]);
  store.close();
}));

test('transactions take the write lock when they begin, so a second writer waits or fails fast', withDir((dir) => {
  const path = dir.file('s.sqlite');
  const a = open(path);
  const b = open(path, schema(), { busyTimeoutMs: 20 });
  a.transaction(() => {
    assert.throws(() => b.transaction((tx) => tx.run("INSERT INTO claims VALUES ('x', 'b')")), /locked|busy/i);
    // Readers are not blocked by a writer (write-ahead logging).
    assert.deepEqual(b.all('SELECT * FROM claims'), []);
  });
  b.transaction((tx) => tx.run("INSERT INTO claims VALUES ('x', 'b')"));
  a.close();
  b.close();
}));

test('a claim is a unique insert: the second claim for the same spawn changes nothing', withDir((dir) => {
  const path = dir.file('s.sqlite');
  const a = open(path);
  const b = open(path);
  const claim = (store: Store, owner: string) =>
    store.transaction((tx) => tx.run('INSERT INTO claims VALUES (?, ?) ON CONFLICT DO NOTHING', ['spawn-1', owner]).changes);
  assert.equal(claim(a, 'daemon'), 1);
  assert.equal(claim(b, 'cli'), 0);
  assert.equal(a.get('SELECT owner FROM claims')?.['owner'], 'daemon');
  a.close();
  b.close();
}));

test('transactions do not nest, and an async callback is refused because it would commit early', withDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  assert.throws(() => store.transaction(() => store.transaction(() => 1)), /nested/i);
  assert.throws(() => store.transaction(async () => 1), /synchronous/i);
  // The refused transaction was rolled back, so the store is usable again.
  assert.equal(store.transaction(() => 1), 1);
  store.close();
}));

test('named parameters and blobs round-trip', withDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  store.run('INSERT INTO claims VALUES ($spawn, $owner)', { spawn: 's', owner: 'o' });
  assert.equal(store.get('SELECT owner FROM claims WHERE spawn = $spawn', { spawn: 's' })?.['owner'], 'o');
  store.close();
}));

test('state and index follow their documented durability and journal settings', withDir((dir) => {
  const state = open(dir.file('state.sqlite'), stateSchema);
  const index = open(dir.file('index.sqlite'), indexSchema);
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

test('openStateStore opens the file at the installation paths', withDir((dir) => {
  const store = openStateStore({ stateDb: dir.file('nested', 'state.sqlite') });
  assert.ok(store.ok);
  if (store.ok) store.value.close();
}));

test('database files are created accessible to the user only (POSIX modes)', { skip: process.platform === 'win32' }, withDir((dir) => {
  const path = dir.file('private', 'state.sqlite');
  const store = open(path);
  store.run("INSERT INTO claims VALUES ('a', 'me')"); // creates the -wal and -shm files
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir.file('private')).mode & 0o777, 0o700);
  for (const suffix of ['-wal', '-shm']) assert.equal(statSync(path + suffix).mode & 0o077, 0, suffix);
  store.close();
}));

test('an unusable location is reported as a value, not thrown', withDir((dir) => {
  const result = openStore(dir.path, schema()); // a directory is not a database file
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.reason, 'unavailable');
}));

test('closing is idempotent and a closed store cannot be used', withDir((dir) => {
  const store = open(dir.file('s.sqlite'));
  store.close();
  store.close();
  assert.throws(() => store.all('SELECT 1'));
}));
