// Documented behaviour: extension.md "Headless sessions" and api.md "Flags" —
// the daemon runs jobs as Pi sessions loading this extension, which takes its
// actor, budget and trace from the run file (`--vault-run`) and gives the job
// the triggering event as structured data. A run that cannot have what it
// needs does not run; a run over its budget or run time is stopped
// (principle 7, gates fail closed). Writes stay in its worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { actorHold } from '../../src/core/actors/index.ts';
import { eventJson } from '../../src/core/conditions/index.ts';
import { withInstallation } from '../support/installation.ts';
import { toolCall, withPi } from '../support/pi.ts';
import { RUNNING, runFileFor, startedSpawn } from '../support/session.ts';


test('a headless run works as its run file says, holding its actor, briefed with its job and event', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry) } }, async (pi) => {
    assert.equal((await actorHold(t.context.state, t.context.alive, 'home', 'gardener'))?.holder.session, pi.runtime.session.sessionId);
    pi.respond(fauxAssistantMessage('Nothing to do.'));
    await pi.prompt('Run the job.');
    const first = JSON.stringify(pi.requests[0]?.messages);
    assert.match(first, /<vault-job source=\\"home:jobs\/daily\.md\\">\\nRun the daily job\./);
    assert.ok(first.includes(JSON.stringify(eventJson(entry.event)).slice(1, -1)), first);
    assert.equal(pi.shutdowns, 0);
  });
  assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'gardener'), undefined, 'released at shutdown');
}, { running: RUNNING }));

test('a run file that cannot be read, or a run without its allotment, does not run: the session shuts down', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  for (const overrides of [{ raw: '{ not json' }, { trace: '01JNOSUCHRUN00000000000000' }, { document: 'jobs/missing.md' }]) {
    await withPi(t, { flags: { 'vault-run': runFileFor(t, entry, overrides) } }, async (pi) => {
      assert.equal(pi.shutdowns, 1, JSON.stringify(overrides));
      assert.ok(pi.notices.some((n) => n.level === 'error'), JSON.stringify(pi.notices));
    });
  }
}, { running: RUNNING }));

test('a run past its budget is stopped', withInstallation(async (t) => {
  const entry = startedSpawn(t, 'jobs/daily.md', 10);
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry) } }, async (pi) => {
    pi.respond(fauxAssistantMessage('Thinking at length.'));
    await pi.prompt('Run the job.');
    assert.equal(pi.shutdowns, 1);
    assert.ok(pi.events.some((e) => e.channel === 'pav:v1:spawn' && (e.data as { state: string; reason?: string }).reason === 'budget'));
  });
}, { running: RUNNING }));

test('a run writes only in its worktree', withInstallation(async (t) => {
  const entry = startedSpawn(t, 'jobs/daily.md', 1_000_000);
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry) } }, async (pi) => {
    pi.respond(toolCall('write', { path: t.dir.file('elsewhere.txt'), content: 'x' }), toolCall('write', { path: join(t.vault.worktrees, 'gardener', 'a.md'), content: 'A' }), fauxAssistantMessage('Done.'));
    await pi.prompt('Run the job.');
    const writes = (pi.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'toolResult' && m.toolName === 'write');
    assert.deepEqual(writes.map((m) => (m as { isError: boolean }).isError), [true, false], 'a blocked call is an error result');
  });
}, { running: RUNNING }));

// extension.md "Headless sessions": the run file's `model` is the `agent` model the daemon started the run with.
test('a run that finds itself on another model than its run file names, or on a model not configured, does not run: its job reaches no model the policy has not allowed', withInstallation(async (t) => {
  // The daemon chose `agent`, configured as other/model; Pi's session runs on the faux model instead.
  const entry = startedSpawn(t);
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry) } }, async (pi) => {
    assert.equal(pi.shutdowns, 1);
    assert.ok(pi.notices.some((n) => n.level === 'error' && /no-model/.test(n.text)), JSON.stringify(pi.notices));
    assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'gardener'), undefined, 'and it holds nothing');
  });
}, { running: RUNNING, noDefaultModels: true, config: 'models:\n  agent: { model: other/model }\npolicy:\n  - { vaults: [home], allow-models: [agent] }' }));

test('a run file naming a model that is not configured does not run, whatever model Pi is on', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  await withPi(t, { flags: { 'vault-run': runFileFor(t, entry, { model: 'quick' }) } }, async (pi) => {
    assert.equal(pi.shutdowns, 1);
    assert.ok(pi.notices.some((n) => n.level === 'error' && /no-model/.test(n.text)), JSON.stringify(pi.notices));
  });
}, { running: RUNNING }));

test('an interactive session runs on whatever model the person chose: it needs no agent model', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    assert.equal(pi.shutdowns, 0);
    pi.respond(fauxAssistantMessage('Hello.'));
    await pi.prompt('Hi.');
    assert.deepEqual(pi.notices.filter((n) => n.level === 'error'), []);
  });
}, { running: RUNNING, noDefaultModels: true }));
