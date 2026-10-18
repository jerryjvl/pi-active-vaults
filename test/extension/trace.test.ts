// Documented behaviour: concepts.md "Trace" — each commit a run makes carries
// its compact record as of that commit, as a note on refs/notes/vault/traces
// (never a file in the tree, so it is no control change), `vault trace` finds
// the run's commits by trailer and reads their notes — also in another clone
// the notes were fetched into — and full detail is kept on the machine; extension.md "Session lifecycle" — `tool_result`
// records results needed for traces, `session_shutdown` flushes the trace.
// Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TRACES_REF, parseCompactTrace, readFullLog } from '../../src/core/traces/index.ts';
import { withInstallation, type TestInstallation } from '../support/installation.ts';
import { DONE, toolCall, withPi } from '../support/pi.ts';
import { RUNNING, runFileFor, startedSpawn } from '../support/session.ts';

/** The compact record in the trace note on `revision`. */
const noteOn = (t: TestInstallation, revision: string) => parseCompactTrace(t.repo.git('notes', `--ref=${TRACES_REF}`, 'show', revision));

test('each of a run\'s commits carries its compact trace as a note: its trigger, its session and the documents it produced', withInstallation(async (t) => {
  const entry = startedSpawn(t, 'jobs/daily.md', 1_000_000);
  const worktree = join(t.vault.worktrees, 'gardener');
  let session = '';
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry) } }, async (pi) => {
    session = pi.runtime.session.sessionId;
    pi.respond(
      toolCall('write', { path: join(worktree, 'notes', 'today.md'), content: '# Today\n' }),
      toolCall('vault_commit', { message: 'Today\'s note' }),
      toolCall('write', { path: join(worktree, 'notes', 'later.md'), content: '# Later\n' }),
      toolCall('vault_commit', { message: 'A later note' }),
      DONE,
    );
    await pi.prompt('Run the job.');
  });
  const first = noteOn(t, 'actor/gardener~1');
  const last = noteOn(t, 'actor/gardener');
  assert.ok(first.ok && last.ok, JSON.stringify([first, last]));
  assert.deepEqual(first.value.documents, ['notes/today.md']);
  assert.deepEqual(last.value.documents, ['notes/later.md', 'notes/today.md'], 'each commit carries everything the run produced so far');
  assert.deepEqual(last.value.trigger, { event: 'manual', document: 'jobs/daily.md' });
  assert.deepEqual(last.value.sessions.map((s) => [s.actor, s.session, s.outcome]), [['gardener', session, 'committed']]);
  assert.ok((last.value.sessions[0]?.tokens ?? 0) > 0, 'its work so far');
  assert.deepEqual(t.repo.git('diff', '--name-only', 'main', 'actor/gardener').split('\n'), ['notes/later.md', 'notes/today.md'], 'nothing but its work in the tree');
  const reviewed = await t.run('review', { actor: 'gardener' });
  assert.equal(reviewed.status, 'ok', reviewed.text);
  assert.doesNotMatch(reviewed.text, /control change/, 'so content alone is no control change');

  const logs = readFullLog(t.installation.paths.logs, entry.trace);
  const lines = logs.filter((l) => l.name === 'session').flatMap((l) => l.text.trim().split('\n')).map((l) => JSON.parse(l) as { kind: string; tool?: string });
  assert.deepEqual(lines.filter((l) => l.kind === 'tool').map((l) => l.tool), ['write', 'vault_commit', 'write', 'vault_commit']);
  assert.equal(lines.at(-1)?.kind, 'end', 'flushed at shutdown');
}, { running: RUNNING }));

test('an interactive session\'s commit carries its trace too, with only the paths it committed', withInstallation(async (t) => {
  const worktree = join(t.vault.worktrees, 'gardener');
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    pi.respond(
      toolCall('write', { path: join(worktree, 'notes', 'a.md'), content: 'A' }),
      toolCall('write', { path: join(worktree, 'notes', 'b.md'), content: 'B' }),
      toolCall('vault_commit', { message: 'Only a', paths: ['home:notes/a.md'] }),
      DONE,
    );
    await pi.prompt('Write.');
  });
  assert.deepEqual(t.repo.git('show', '--name-only', '--format=', 'actor/gardener').split('\n'), ['notes/a.md']);
  const record = noteOn(t, 'actor/gardener');
  assert.ok(record.ok);
  assert.deepEqual(record.value.trigger, { event: 'session.start' });
  assert.deepEqual(record.value.documents, ['notes/a.md']);
}, { running: RUNNING, config: 'taint: { trusted-tools: [read, write, vault_commit] }' }));

test('a commit with nothing to commit is no commit, and records nothing', withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    pi.respond(toolCall('vault_commit', { message: 'Nothing done' }), DONE);
    await pi.prompt('Commit.');
    const result = pi.results.find((r) => r.tool === 'vault_commit');
    assert.equal(result?.isError, true);
    assert.match(result?.text ?? '', /nothing to commit/i);
  });
  assert.equal(t.repo.git('branch', '--list', 'actor/gardener') === '' || t.repo.git('rev-parse', 'actor/gardener') === t.repo.git('rev-parse', 'main'), true);
  assert.equal(t.repo.git('notes', `--ref=${TRACES_REF}`, 'list'), '');
}, { running: RUNNING, config: 'taint: { trusted-tools: [vault_commit] }' }));

test('vault trace reads a run\'s records back from its commits\' notes, also in another clone they were fetched into', withInstallation(async (t) => {
  const entry = startedSpawn(t, 'jobs/daily.md', 1_000_000);
  const worktree = join(t.vault.worktrees, 'gardener');
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry) } }, async (pi) => {
    pi.respond(
      toolCall('write', { path: join(worktree, 'notes', 'one.md'), content: '# One\n' }),
      toolCall('vault_commit', { message: 'One' }),
      toolCall('write', { path: join(worktree, 'notes', 'two.md'), content: '# Two\n' }),
      toolCall('vault_commit', { message: 'Two' }),
      DONE,
    );
    await pi.prompt('Run the job.');
  });
  const here = await t.run('trace', { id: entry.trace });
  assert.equal(here.status, 'ok', here.text);
  assert.match(here.text, /home: manual jobs\/daily\.md[^]*produced notes\/one\.md\n {2}produced notes\/two\.md/);
  assert.match(here.text, /commits: [0-9a-f]{12}, [0-9a-f]{12}/);

  await withInstallation(async (other) => {
    other.repo.git('fetch', '--quiet', t.repo.path, 'actor/gardener:refs/heads/actor/gardener', `${TRACES_REF}:${TRACES_REF}`);
    const there = await other.run('trace', { id: entry.trace });
    assert.equal(there.status, 'ok', there.text);
    assert.match(there.text, /home: manual jobs\/daily\.md[^]*produced notes\/one\.md\n {2}produced notes\/two\.md/);
    assert.doesNotMatch(there.text, /Full logs/, 'the logs stay on the machine that ran it');
  })();
}, { running: RUNNING }));
