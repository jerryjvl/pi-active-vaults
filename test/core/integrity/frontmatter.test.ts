// Documented behaviour: architecture.md "Reads from the accepted main" — the
// frontmatter of every document at a commit is read in one scan, from the
// commit and never the working tree, and kept across processes by blob in
// the index, so only changed content is parsed again. The kept copy is
// derived and disposable: it is used only for the exact blob it came from,
// and a cache that cannot be read or written never fails the scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatterCache, readsSchema, type FrontmatterCache } from '../../../src/core/integrity/index.ts';
import { scanFrontmatter } from '../../../src/core/integrity/frontmatter.ts';
import type { Store } from '../../../src/core/store/index.ts';
import { countingGit } from '../../support/git-repo.ts';
import { withStore } from '../../support/store.ts';
import { withTestVault, type TestVault } from '../../support/vault.ts';

const scan = (v: TestVault, cache?: FrontmatterCache, git = v.git) => scanFrontmatter(git, v.vault.path, v.vault.id, v.accept().sha, cache);

test('every document\'s frontmatter is read from the commit, in tree order; one that cannot be parsed says why', withTestVault(async (v) => {
  v.repo.write('notes/a.md', '---\ntitle: A\n---\nBody.\n');
  v.repo.write('notes/b.md', '# No frontmatter\n');
  v.repo.write('notes/broken.md', '---\ntitle: [unclosed\n---\n');
  v.repo.write('notes/data.json', '{}');
  v.repo.commit('notes');
  v.repo.write('notes/a.md', '---\ntitle: Uncommitted\n---\n');
  const read = await scan(v);
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual([...read.value.keys()], ['_contract.md', 'notes/a.md', 'notes/b.md', 'notes/broken.md']);
  assert.deepEqual(read.value.get('notes/a.md'), { state: 'read', frontmatter: { title: 'A' } });
  assert.deepEqual(read.value.get('notes/b.md'), { state: 'read', frontmatter: {} });
  assert.equal(read.value.get('notes/broken.md')?.state, 'unreadable');
}));

test('a scan runs the same few git processes however many documents and directories the tree has', withTestVault(async (v) => {
  const counted = countingGit(v.git, v.repo);
  v.repo.write('one/a.md', 'a');
  v.repo.commit('small');
  assert.ok((await scan(v, undefined, counted.git)).ok);
  const small = counted.processes();
  for (let i = 0; i < 40; i += 1) v.repo.write(`d${i % 20}/sub/n${i}.md`, `---\nn: ${i}\n---\n`);
  v.repo.commit('large');
  counted.reset();
  assert.ok((await scan(v, undefined, counted.git)).ok);
  assert.equal(counted.processes(), small);
  assert.ok(small <= 3, `${small} processes`);
}));

const withCache = (run: (v: TestVault, store: Store) => Promise<void>) =>
  withStore([readsSchema], (store) => withTestVault((v) => run(v, store))());

test('kept across processes, unchanged documents are not read again; changed ones are', withCache(async (v, store) => {
  v.repo.write('notes/a.md', '---\ntitle: A\n---\n');
  v.repo.write('notes/b.md', '---\ntitle: B\n---\n');
  v.repo.commit('notes');
  const first = await scan(v, frontmatterCache(() => store));
  assert.ok(first.ok);

  // A new process: a new cache over the same store.
  const counted = countingGit(v.git, v.repo);
  const again = await scan(v, frontmatterCache(() => store), counted.git);
  assert.deepEqual(again, first);
  assert.equal(counted.processes('cat-file'), 0, 'nothing is read');

  v.repo.write('notes/b.md', '---\ntitle: B2\n---\n');
  v.repo.commit('b changes');
  const changed = await scan(v, frontmatterCache(() => store));
  assert.ok(changed.ok);
  assert.deepEqual(changed.value.get('notes/b.md'), { state: 'read', frontmatter: { title: 'B2' } });
  assert.deepEqual(changed.value.get('notes/a.md'), { state: 'read', frontmatter: { title: 'A' } });
}));

test('a kept value is used only for the exact blob it was parsed from', withCache(async (v, store) => {
  v.repo.write('notes/a.md', '---\ntitle: A\n---\n');
  v.repo.commit('notes');
  assert.ok((await scan(v, frontmatterCache(() => store))).ok);
  // Another process's row for other content at the same path: a miss, never its value.
  store.run("UPDATE reads_frontmatter SET blob = ?, value = ? WHERE path = 'notes/a.md'", ['0'.repeat(40), JSON.stringify({ state: 'read', frontmatter: { title: 'Other' } })]);
  const read = await scan(v, frontmatterCache(() => store));
  assert.ok(read.ok);
  assert.deepEqual(read.value.get('notes/a.md'), { state: 'read', frontmatter: { title: 'A' } });
  assert.notEqual(store.get<{ blob: string }>("SELECT blob FROM reads_frontmatter WHERE path = 'notes/a.md'")?.blob, '0'.repeat(40), 'the row is replaced');
}));

test('a path the tree no longer has is forgotten', withCache(async (v, store) => {
  v.repo.write('notes/a.md', 'a');
  v.repo.commit('a');
  assert.ok((await scan(v, frontmatterCache(() => store))).ok);
  v.repo.git('rm', '--quiet', 'notes/a.md');
  v.repo.commit('gone');
  assert.ok((await scan(v, frontmatterCache(() => store))).ok);
  assert.deepEqual(store.all('SELECT path FROM reads_frontmatter ORDER BY path'), [{ path: '_contract.md' }]);
}));

test('a value JSON cannot hold is not kept, and is read correctly every time', withCache(async (v, store) => {
  v.repo.write('notes/odd.md', '---\nlimit: .inf\nzero: -0.0\n---\n');
  v.repo.commit('odd');
  for (let i = 0; i < 2; i += 1) {
    const read = await scan(v, frontmatterCache(() => store));
    assert.ok(read.ok);
    assert.deepEqual(read.value.get('notes/odd.md'), { state: 'read', frontmatter: { limit: Infinity, zero: -0 } });
  }
  assert.equal(store.get("SELECT 1 AS kept FROM reads_frontmatter WHERE path = 'notes/odd.md'"), undefined);
}));

test('a cache that cannot be read or written never fails the scan', withCache(async (v, store) => {
  v.repo.write('notes/a.md', '---\ntitle: A\n---\n');
  v.repo.commit('a');
  const expected = await scan(v);
  assert.ok(expected.ok);
  const failing = frontmatterCache(() => { throw new Error('the index cannot be opened'); });
  assert.deepEqual(await scan(v, failing), expected);
  assert.deepEqual(await scan(v, frontmatterCache(() => undefined)), expected);

  assert.ok((await scan(v, frontmatterCache(() => store))).ok);
  store.run("UPDATE reads_frontmatter SET value = 'not json' WHERE path = 'notes/a.md'");
  store.run("UPDATE reads_frontmatter SET value = '{\"state\":\"read\"}' WHERE path = '_contract.md'");
  assert.deepEqual(await scan(v, frontmatterCache(() => store)), expected);
}));
