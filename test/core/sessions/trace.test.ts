// Documented behaviour: concepts.md "Trace" — every run has a trace: a
// compact record in the vault (its trigger, the causal path of runs that led
// to it, its sessions, scripts and documents produced, and other vaults only
// as opaque references), and full detail on the machine as JSON lines per day
// and trace. extension.md "Session lifecycle" — tool results are recorded for
// the trace, and the trace is flushed at shutdown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSession, logToolResult, openSession, traceRecord } from '../../../src/core/sessions/index.ts';
import { opaqueReference, readFullLog } from '../../../src/core/traces/index.ts';
import { withInstallation } from '../../support/installation.ts';
import { AGENT_MODEL } from '../../support/models.ts';
import { ME, RUNNING, openTestSession, runOf, startedSpawn } from '../../support/session.ts';

test('a headless run\'s record names its trigger, the runs that led to it, its session and its scripts', withInstallation(async (t) => {
  const parent = await openTestSession(t);
  const entry = startedSpawn(t, 'jobs/daily.md', 5000, parent.trace);
  const opened = await openSession(t.context, { session: 'run-session', pid: ME, cwd: t.repo.path, model: AGENT_MODEL, run: runOf(entry) });
  assert.ok(opened.ok, JSON.stringify(!opened.ok && opened.error));
  const { session } = opened.value;
  logToolResult(t.context, session, { tool: 'vault_script', input: { name: 'due-topics' }, isError: false, text: 'a\nb', data: { status: 'ok', data: { exitCode: 0 } } });
  logToolResult(t.context, session, { tool: 'vault_script', input: { name: 'broken' }, isError: true, text: 'no', data: { status: 'failed', data: { exitCode: 2 } } });
  session.touched.add('other');
  const record = traceRecord(t.context, session, 'home');
  assert.deepEqual(record.trigger, { event: 'manual', document: 'jobs/daily.md' });
  assert.deepEqual(record.path, [parent.trace]);
  assert.equal(record.trace, entry.trace);
  assert.deepEqual(record.sessions.map((s) => [s.actor, s.session, s.outcome, s.tokens]), [['gardener', 'run-session', 'committed', 0]]);
  assert.deepEqual(record.scripts, [{ name: 'due-topics', exitCode: 0 }, { name: 'broken', exitCode: 2 }]);
  assert.deepEqual(record.elsewhere, [opaqueReference(entry.trace, 'other')], 'another vault only as an opaque reference');
  assert.deepEqual(record.judgements, []);
}, { running: RUNNING }));

test('an interactive session is the root of its trace, started by the session itself', withInstallation(async (t) => {
  const session = await openTestSession(t);
  const record = traceRecord(t.context, session, 'home');
  assert.deepEqual(record.trigger, { event: 'session.start' });
  assert.deepEqual(record.path, []);
  assert.deepEqual(record.elsewhere, []);
}, { running: RUNNING }));

test('tool results and the session\'s end go to its full log, as JSON lines', withInstallation(async (t) => {
  const session = await openTestSession(t);
  logToolResult(t.context, session, { tool: 'read', input: { path: 'notes/a.md' }, isError: false, text: 'Hello.' });
  closeSession(t.context, session);
  const logs = readFullLog(t.installation.paths.logs, session.trace);
  assert.deepEqual(logs.map((l) => l.name), ['session']);
  const lines = (logs[0]?.text ?? '').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map((l) => l['kind']), ['start', 'tool', 'end']);
  assert.deepEqual([lines[1]?.['tool'], lines[1]?.['text'], lines[1]?.['isError']], ['read', 'Hello.', false]);
  assert.equal(lines[2]?.['session'], 'pi-session-1');
}, { running: RUNNING }));

test('a very large tool result is logged cut short, and says so', withInstallation(async (t) => {
  const session = await openTestSession(t);
  logToolResult(t.context, session, { tool: 'read', input: {}, isError: false, text: 'x'.repeat(2_000_000) });
  const line = JSON.parse((readFullLog(t.installation.paths.logs, session.trace)[0]?.text ?? '').trim().split('\n')[1] ?? '{}') as { text: string; truncated?: boolean };
  assert.equal(line.truncated, true);
  assert.ok(line.text.length < 2_000_000);
}, { running: RUNNING }));
