// Documented behaviour: concepts.md "applies-when" — `script` is a spawn's
// precise escape hatch: an approved script that receives the event as JSON on
// standard input, run only after every other field matched, which can only
// narrow the match (the spawn happens only if it exits 0). It runs from the
// accepted `main`, like every script, so it fails closed: a script that cannot
// run, or any unaccepted change, means no spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { narrowByScripts, type Condition, type Match, type ScriptFilterOptions, type VaultEvent } from '../../../src/core/conditions/index.ts';
import { scriptSource as script, withTestVault, type TestVault } from '../../support/vault.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };

const options: ScriptFilterOptions = {
  builtins: [],
  env: { PATH: process.env['PATH'] ?? '' },
  timeoutMs: 10_000,
  os: process.platform === 'darwin' ? 'darwin' : 'linux',
  sandbox: 'none',
};

const event: VaultEvent = {
  kind: 'merged', vault: 'home', commit: 'a'.repeat(40),
  changes: [{ commit: 'a'.repeat(40), path: 'topics/a.md', change: 'modified', labels: [] }],
};

const match = (document: string, fields: Partial<Condition> = {}): Match =>
  ({ vault: 'home', document, index: 0, condition: { on: 'merged', effect: 'spawn', context: 'session-preferred', ...fields } });

const narrow = (v: TestVault, matches: Match[]) =>
  narrowByScripts({ git: v.git, store: v.store, locate: (id) => (id === v.vault.id ? v.vault : undefined) }, options, event, matches);

test('a match is kept only when its script, given the event as JSON on standard input, exits 0', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/only-topics.sh', script('only-topics', 'grep -q \'"path":"topics/\''));
  v.repo.write('.vault/scripts/only-notes.sh', script('only-notes', 'grep -q \'"path":"notes/\''));
  v.repo.commit('filters');
  v.accept();
  const narrowed = await narrow(v, [match('a.md', { script: 'only-topics' }), match('b.md', { script: 'only-notes' }), match('c.md')]);
  assert.deepEqual(narrowed.kept.map((m) => m.document), ['a.md', 'c.md']);
  assert.deepEqual(narrowed.dropped.map((d) => [d.match.document, d.reason]), [['b.md', 'exit 1']]);
}));

test('the script is the accepted main\'s version, never the working tree\'s', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/filter.sh', script('filter', 'exit 1'));
  v.repo.commit('filter');
  v.accept();
  v.repo.write('.vault/scripts/filter.sh', script('filter', 'exit 0'));
  const narrowed = await narrow(v, [match('a.md', { script: 'filter' })]);
  assert.deepEqual(narrowed.kept, []);
}));

test('a script that cannot run, or an unaccepted change, drops the match and runs nothing', posixOnly, withTestVault(async (v) => {
  const marker = join(v.repo.path, 'ran');
  v.repo.write('.vault/scripts/mark.sh', script('mark', `touch "${marker}"`));
  v.repo.commit('mark');
  v.accept();

  const missing = await narrow(v, [match('a.md', { script: 'nope' })]);
  assert.deepEqual(missing.dropped.map((d) => d.reason), ['no-such-script']);
  const elsewhere = await narrowByScripts({ git: v.git, store: v.store, locate: () => undefined }, options, event, [match('a.md', { script: 'mark' })]);
  assert.deepEqual(elsewhere.dropped.map((d) => d.reason), ['unknown-vault']);

  v.repo.write('stray.md', 'x');
  v.repo.commit('stray commit on main');
  const paused = await narrow(v, [match('a.md', { script: 'mark' }), match('b.md')]);
  assert.deepEqual(paused.kept.map((m) => m.document), ['b.md'], 'a match without a script is not the script\'s to drop');
  assert.deepEqual(paused.dropped.map((d) => d.reason), ['unaccepted-change']);
  assert.equal(existsSync(marker), false);
}));

test('a script past its time limit drops the match', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/slow.sh', script('slow', 'sleep 5'));
  v.repo.commit('slow');
  v.accept();
  const narrowed = await narrowByScripts(
    { git: v.git, store: v.store, locate: () => v.vault }, { ...options, timeoutMs: 100 }, event, [match('a.md', { script: 'slow' })]);
  assert.deepEqual(narrowed.dropped.map((d) => d.reason), ['timed-out']);
}));
