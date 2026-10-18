// Documented behaviour: concepts.md "Trace" — a run's compact record is
// committed with its other changes on its actor branch, and full detail is
// kept on the machine; extension.md "Session lifecycle" — `tool_result`
// records results needed for traces, `session_shutdown` flushes the trace.
// Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compactTracePath, parseCompactTrace, readFullLog } from '../../src/core/traces/index.ts';
import { withInstallation } from '../support/installation.ts';
import { DONE, toolCall, withPi } from '../support/pi.ts';
import { RUNNING, runFileFor, startedSpawn } from '../support/session.ts';

test('a run\'s commit carries its compact trace: its trigger, its session and the documents it produced', withInstallation(async (t) => {
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
  const first = parseCompactTrace(t.repo.git('show', `actor/gardener~1:${compactTracePath(entry.trace)}`));
  const last = parseCompactTrace(t.repo.git('show', `actor/gardener:${compactTracePath(entry.trace)}`));
  assert.ok(first.ok && last.ok, JSON.stringify([first, last]));
  assert.deepEqual(first.value.documents, ['notes/today.md']);
  assert.deepEqual(last.value.documents, ['notes/later.md', 'notes/today.md'], 'each commit carries everything the run produced so far');
  assert.deepEqual(last.value.trigger, { event: 'manual', document: 'jobs/daily.md' });
  assert.deepEqual(last.value.sessions.map((s) => [s.actor, s.session, s.outcome]), [['gardener', session, 'committed']]);
  assert.ok((last.value.sessions[0]?.tokens ?? 0) > 0, 'its work so far');

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
  const files = t.repo.git('show', '--name-only', '--format=', 'actor/gardener').split('\n');
  const traceFile = files.find((f) => f.startsWith('.vault/traces/'));
  assert.ok(traceFile !== undefined, files.join(', '));
  assert.deepEqual(files.filter((f) => f !== traceFile), ['notes/a.md']);
  const record = parseCompactTrace(t.repo.git('show', `actor/gardener:${traceFile}`));
  assert.ok(record.ok);
  assert.deepEqual(record.value.trigger, { event: 'session.start' });
  assert.deepEqual(record.value.documents, ['notes/a.md']);
}, { running: RUNNING, config: 'taint: { trusted-tools: [read, write, vault_commit] }' }));

test('a commit with nothing but the trace record is no commit', withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    pi.respond(toolCall('vault_commit', { message: 'Nothing done' }), DONE);
    await pi.prompt('Commit.');
    const result = pi.results.find((r) => r.tool === 'vault_commit');
    assert.equal(result?.isError, true);
    assert.match(result?.text ?? '', /nothing to commit/i);
  });
  assert.equal(t.repo.git('branch', '--list', 'actor/gardener') === '' || t.repo.git('rev-parse', 'actor/gardener') === t.repo.git('rev-parse', 'main'), true);
}, { running: RUNNING, config: 'taint: { trusted-tools: [vault_commit] }' }));
