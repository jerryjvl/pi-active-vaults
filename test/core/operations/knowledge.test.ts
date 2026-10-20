// Documented behaviour: cli.md "Knowledge" — `read` prints a document with its
// freshness against the accepted main, `contract` the effective contract with
// each key's origin, `reindex` rebuilds the search index and `search` searches
// it. security.md — reading continues during an unaccepted change, from the
// accepted main; an index update is refused then. Search without an embedding
// model is keyword-only and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROGRESS_EVERY_MS, progressReporter } from '../../../src/core/operations/ops/knowledge.ts';
import { fakeClock } from '../../support/clock.ts';
import { withInstallation } from '../../support/installation.ts';

test('read shows the accepted main\'s version and whether main has since changed or removed it', withInstallation(async (t) => {
  t.repo.write('notes/a.md', '# A\nline two\nline three\n');
  t.repo.write('notes/b.md', '# B\n');
  t.repo.commit('notes');
  t.accept();
  const read = await t.run('read', { path: 'notes/a.md' });
  assert.equal(read.status, 'ok');
  assert.equal(read.text, '# A\nline two\nline three\n');
  assert.deepEqual((read.data as { freshness: string }).freshness, 'current');
  assert.equal((await t.run('read', { path: 'notes/a.md', range: '2-3' })).text, 'line two\nline three');

  t.repo.write('notes/a.md', '# A, edited\n');
  t.repo.git('rm', '--quiet', 'notes/b.md');
  t.repo.commit('unaccepted edits');
  const changed = await t.run('read', { path: 'notes/a.md' });
  assert.equal(changed.status, 'ok', 'reading continues during an unaccepted change');
  assert.match(changed.text, /^# A\nline two/);
  assert.equal((changed.data as { freshness: string }).freshness, 'changed');
  assert.equal(((await t.run('read', { path: 'notes/b.md' })).data as { freshness: string }).freshness, 'gone');
  const missing = await t.run('read', { path: 'notes/none.md' });
  assert.equal(missing.status, 'failed');
}));

test('contract shows each key with the contracts it came from', withInstallation(async (t) => {
  t.repo.write('topics/_contract.md', '---\nindex: opt-in\nnaming: "{topic}.md"\n---\nTopic prose.\n');
  t.repo.commit('contract');
  t.accept();
  const shown = await t.run('contract', { path: 'topics/cars.md' });
  assert.equal(shown.status, 'ok');
  const data = shown.data as { values: Record<string, unknown>; origins: Record<string, string[]> };
  assert.equal(data.values['index'], 'opt-in');
  assert.deepEqual(data.origins['index'], ['topics/_contract.md']);
  assert.deepEqual(data.origins['vault'], ['_contract.md']);
  assert.match(shown.text, /Topic prose\./);
}));

test('reindex builds the index from the accepted main, search finds it keyword-only and says so; reindex is refused during an unaccepted change', withInstallation(async (t) => {
  t.repo.write('notes/router.md', '# Router\nThe router lives in the hall cupboard.\n');
  t.repo.commit('router');
  t.accept();
  const reindexed = await t.run('reindex');
  assert.equal(reindexed.status, 'ok', reindexed.text);
  const found = await t.run('search', { query: 'cupboard router' });
  assert.equal(found.status, 'ok');
  assert.match(found.text, /^home:notes\/router\.md — Router \[current\]/);
  assert.match(found.text, /Keyword search only \(no-embed-model\)/);

  t.repo.write('stray.md', 'stray');
  t.repo.commit('stray');
  const paused = await t.run('reindex');
  assert.equal(paused.status, 'refused');
  assert.match(paused.text, /unaccepted change/);
  assert.equal((await t.run('search', { query: 'stray' })).text.startsWith('No hits.'), true, 'unaccepted content is never searchable');
}));

test('a request that does not fit the operation is invalid, not refused: parameters that fail their specs, a query with no words', withInstallation(async (t) => {
  const missing = await t.run('read', {});
  assert.equal(missing.status, 'invalid');
  assert.match(missing.text, /path: is required/);
  assert.equal((await t.run('search', { query: '"" *' })).status, 'invalid');
}));

test('reindex progress: nothing for a quick update; for a long one, a line every few seconds and at the end of each phase', () => {
  const clock = fakeClock();
  const lines: string[] = [];
  const report = progressReporter(clock, (line) => lines.push(line));
  const at = (done: number, total = 10, phase: 'reading' | 'embedding' = 'embedding') => report({ vault: 'library', phase, done, total });
  at(1); at(2, 10, 'reading');
  clock.advance(PROGRESS_EVERY_MS - 1);
  at(10, 10, 'reading');
  assert.deepEqual(lines, [], 'quiet before the first few seconds, even at a phase end');
  clock.advance(1);
  at(3);
  clock.advance(1000);
  at(4);
  assert.deepEqual(lines, ['library: embedding chunks 3 / 10 (30%)'], 'then one line, and none sooner than the next interval');
  at(10);
  clock.advance(PROGRESS_EVERY_MS);
  at(4_743, 4_743, 'reading');
  assert.deepEqual(lines.slice(1), ['library: embedding chunks 10 / 10 (100%)', 'library: reading documents 4,743 / 4,743 (100%)'], 'a phase end is always told');
});
