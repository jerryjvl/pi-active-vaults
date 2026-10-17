// Documented behaviour: core.md "events" and concepts.md "applies-when" — Git
// events are derived from a ref range, with paths, change kinds, renames and
// the labels of changed documents, and the actor and run that made each
// change. A merge into `main` is one `merged` event; each commit on a branch is
// a `committed` event. Uncommitted edits are not events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEvents } from '../../../src/core/events/index.ts';
import { gitFor, withTempRepo, type TempRepo } from '../../support/git-repo.ts';

const doc = (labels: string[], body = 'text'): string => `---\nlabels: [${labels.join(', ')}]\n---\n${body}\n`;

function mergeBranch(repo: TempRepo, branch: string, message: string): string {
  repo.git('checkout', '--quiet', 'main');
  repo.git('merge', '--quiet', '--no-ff', '-m', message, branch);
  return repo.git('rev-parse', 'HEAD');
}

test('each first-parent step on main is one merged event carrying everything that step brought', withTempRepo(async (repo) => {
  repo.write('topics/a.md', doc(['cars']));
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('topics/b.md', doc(['boats']));
  const addB = repo.commit('add b');
  repo.write('topics/a.md', doc(['cars'], 'edited'));
  const editA = repo.commit('edit a');
  const merge = mergeBranch(repo, 'actor/gardener', 'accept gardener');
  repo.write('notes/c.txt', 'plain');
  const direct = repo.commit('adopted direct commit');

  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: base, to: direct });
  assert.ok(events.ok);
  assert.deepEqual(events.value, [
    {
      kind: 'merged', vault: 'home', commit: merge,
      changes: [
        { path: 'topics/a.md', change: 'modified', labels: ['cars'], commit: editA },
        { path: 'topics/b.md', change: 'created', labels: ['boats'], commit: addB },
      ],
    },
    { kind: 'merged', vault: 'home', commit: direct, changes: [{ path: 'notes/c.txt', change: 'created', labels: [], commit: direct }] },
  ]);
}));

test('each commit on a branch is one committed event; merges into the branch are not the actor\'s work', withTempRepo(async (repo) => {
  repo.write('a.md', doc([]));
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('b.md', doc(['x']));
  const first = repo.commit('first\n\nVault-Trace: 01TRACE\nVault-Actor: gardener\nVault-Session: S1');
  repo.git('checkout', '--quiet', 'main');
  repo.write('c.md', doc([]));
  repo.commit('main moves on');
  repo.git('checkout', '--quiet', 'actor/gardener');
  repo.git('merge', '--quiet', '--no-ff', '-m', 'sync', 'main');
  repo.write('d.md', doc([]));
  const second = repo.commit('second');

  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'committed', from: base, to: 'actor/gardener' });
  assert.ok(events.ok);
  assert.deepEqual(events.value.map((e) => [e.commit, e.changes.map((c) => c.path)]), [[first, ['b.md']], [second, ['d.md']]]);
  assert.equal(events.value[0]?.trace, '01TRACE');
  assert.equal(events.value[0]?.session, 'S1');
  assert.equal(events.value[1]?.trace, undefined);
}));

test('a deleted document carries the labels it had; a renamed one its new path, old path and labels', withTempRepo(async (repo) => {
  repo.write('topics/old.md', doc(['cars']));
  repo.write('topics/gone.md', doc(['boats']));
  const base = repo.commit('base');
  repo.git('mv', 'topics/old.md', 'topics/new.md');
  repo.git('rm', '--quiet', 'topics/gone.md');
  const change = repo.commit('rename and delete');
  const by = { commit: change };
  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: base, to: change });
  assert.ok(events.ok);
  assert.deepEqual(events.value[0]?.changes, [
    { path: 'topics/gone.md', change: 'deleted', labels: ['boats'], ...by },
    { path: 'topics/new.md', change: 'renamed', oldPath: 'topics/old.md', labels: ['cars'], ...by },
  ]);
}));

test('documents whose labels cannot be read carry none, rather than failing the event', withTempRepo(async (repo) => {
  const base = repo.commit('empty');
  repo.write('broken.md', '---\nlabels: [unclosed\n---\n');
  repo.write('scalar.md', '---\nlabels: cars\n---\n');
  const sha = repo.commit('odd labels');
  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: base, to: sha });
  assert.ok(events.ok);
  assert.deepEqual(events.value[0]?.changes.map((c) => c.labels), [[], []]);
}));

test('a range from nothing starts at the first commit, and the working tree is never read', withTempRepo(async (repo) => {
  repo.write('a.md', doc(['x']));
  const first = repo.commit('first');
  repo.write('a.md', doc(['changed-but-not-committed']));
  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: null, to: first });
  assert.ok(events.ok);
  assert.deepEqual(events.value, [{ kind: 'merged', vault: 'home', commit: first, changes: [{ path: 'a.md', change: 'created', labels: ['x'], commit: first }] }]);
}));

test('an unknown end of the range is an error', withTempRepo(async (repo) => {
  repo.commit('first');
  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: null, to: 'nope' });
  assert.equal(!events.ok && events.error.reason, 'unknown-revision');
}));

const trailers = (trace: string, actor: string): string => `\n\nVault-Trace: ${trace}\nVault-Actor: ${actor}`;

test('a merge attributes each change to the commit that made it, with that commit\'s actor and run', withTempRepo(async (repo) => {
  repo.write('a.md', doc([]));
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('topics/x.md', doc([]));
  const first = repo.commit(`run one${trailers('01RUNONE', 'gardener')}`);
  repo.write('topics/y.md', doc([]));
  const second = repo.commit(`run two${trailers('01RUNTWO', 'gardener')}`);
  repo.write('notes/z.md', doc([]));
  const person = repo.commit('a person\'s own edit');
  repo.write('topics/x.md', doc([], 'edited again'));
  const again = repo.commit(`run two again${trailers('01RUNTWO', 'gardener')}`);
  const merge = mergeBranch(repo, 'actor/gardener', 'accept gardener');

  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: base, to: merge });
  assert.ok(events.ok);
  assert.deepEqual(events.value[0]?.changes, [
    { path: 'notes/z.md', change: 'created', labels: [], commit: person },
    { path: 'topics/x.md', change: 'created', labels: [], commit: again, actor: 'gardener', trace: '01RUNTWO' },
    { path: 'topics/y.md', change: 'created', labels: [], commit: second, actor: 'gardener', trace: '01RUNTWO' },
  ], 'a path two commits changed belongs to the later one');
  assert.notEqual(first, again);
}));

test('a rebased or amended commit keeps its run, because its message keeps the trailer', withTempRepo(async (repo) => {
  repo.write('a.md', doc([]));
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('topics/x.md', doc([]));
  repo.commit(`work${trailers('01RUN', 'gardener')}`);
  repo.git('checkout', '--quiet', 'main');
  repo.write('other.md', doc([]));
  repo.commit('main moves on');
  repo.git('checkout', '--quiet', 'actor/gardener');
  repo.git('rebase', '--quiet', 'main');
  repo.git('commit', '--quiet', '--amend', '--no-edit');
  const rebased = repo.git('rev-parse', 'HEAD');
  const merge = mergeBranch(repo, 'actor/gardener', 'accept');
  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'merged', from: base, to: merge });
  assert.ok(events.ok);
  assert.deepEqual(events.value.at(-1)?.changes, [{ path: 'topics/x.md', change: 'created', labels: [], commit: rebased, actor: 'gardener', trace: '01RUN' }]);
}));

test('a commit\'s own changes are attributed to it', withTempRepo(async (repo) => {
  const base = repo.commit('base');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('b.md', doc([]));
  const sha = repo.commit(`work${trailers('01RUN', 'gardener')}`);
  const events = await deriveEvents(gitFor(repo), repo.path, 'home', { kind: 'committed', from: base, to: 'actor/gardener' });
  assert.ok(events.ok);
  assert.deepEqual(events.value[0]?.changes, [{ path: 'b.md', change: 'created', labels: [], commit: sha, actor: 'gardener', trace: '01RUN' }]);
}));
