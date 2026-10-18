// Documented behaviour: extension.md "Session lifecycle" and "Behaviour", api.md
// "Hooks" — at session start the extension takes the actor's hold (or reports
// who holds it) and injects `session.start` documents; the vault catalog is in
// the system prompt; tool calls pass the write guard, record session events
// and inject contracts and `inject` documents for newly touched paths; tool
// results mark the session tainted when it used an untrusted tool or read
// outside the vaults; each turn's tokens are recorded against the budget;
// shutdown releases the actor. Matching session events spawn work, sent or
// queued with a fixed identity. Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actorHold, takeActorHold } from '../../src/core/actors/index.ts';
import { budgetState } from '../../src/core/budgets/index.ts';
import { listSpawns } from '../../src/core/queue/index.ts';
import { withInstallation } from '../support/installation.ts';
import { DONE, toolResults, toolCall, withPi } from '../support/pi.ts';
import { OTHER_HOLDER, RUNNING } from '../support/session.ts';


test('the session holds its actor while it runs, and releases it at shutdown', withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    const hold = await actorHold(t.context.state, t.context.alive, 'home', 'gardener');
    assert.equal(hold?.holder.session, pi.runtime.session.sessionId);
  });
  assert.equal(await actorHold(t.context.state, t.context.alive, 'home', 'gardener'), undefined);
}, { running: RUNNING }));

test('a busy actor is reported at the start, naming the session that holds it', withInstallation(async (t) => {
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'gardener', holder: OTHER_HOLDER })).ok);
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    assert.ok(pi.notices.some((n) => /gardener is held by session other-session/.test(n.text)), JSON.stringify(pi.notices));
  });
}, { running: RUNNING }));

test('the system prompt lists the vault catalog; the start reports unaccepted changes to the person and the model', withInstallation(async (t) => {
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  await withPi(t, {}, async (pi) => {
    pi.respond(DONE);
    await pi.prompt('Hello.');
    const [first] = pi.requests;
    assert.match(first?.system ?? '', /## Knowledge vaults[^]*- home: Home things\./);
    assert.ok(pi.notices.some((n) => /main has 1 unaccepted commit/.test(n.text)));
    assert.match(JSON.stringify(first?.messages), /main has 1 unaccepted commit/);
  });
}, { running: RUNNING }));

test('writes outside the session\'s worktree are blocked with where to write instead; writes in it go through', withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    const worktree = join(t.vault.worktrees, 'gardener');
    pi.respond(
      toolCall('write', { path: 'notes/a.md', content: 'In the checkout.' }),
      toolCall('write', { path: join(worktree, 'notes', 'b.md'), content: 'In the worktree.' }),
      DONE,
    );
    await pi.prompt('Write.');
    assert.equal(existsSync(join(t.repo.path, 'notes', 'a.md')), false);
    assert.equal(readFileSync(join(worktree, 'notes', 'b.md'), 'utf8'), 'In the worktree.');
    const [blocked] = toolResults(pi.requests.at(-1), 'write');
    assert.match(blocked ?? '', new RegExp(`checkout, which holds main[^]*${join(worktree, 'notes', 'a.md').replace(/[\\/.]/g, '.')}`));
  });
}, { running: RUNNING }));

test('a shell command that pushes is blocked', { skip: process.platform === 'win32' ? 'bash' : false }, withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    pi.respond(toolCall('bash', { command: 'git push origin actor/gardener' }), DONE);
    await pi.prompt('Push.');
    assert.match(toolResults(pi.requests.at(-1), 'bash')[0] ?? '', /Pushing is not for sessions/);
  });
}, { running: RUNNING }));

test('an untrusted tool taints the session, and its commits say so', { skip: process.platform === 'win32' ? 'bash' : false }, withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    pi.respond(
      toolCall('bash', { command: 'echo fetched' }),
      toolCall('write', { path: join(t.vault.worktrees, 'gardener', 'a.md'), content: 'A' }),
      toolCall('vault_commit', { message: 'After an untrusted tool' }),
      DONE,
    );
    await pi.prompt('Work.');
    assert.match(t.repo.git('log', '-1', '--format=%B', 'refs/heads/actor/gardener'), /Vault-Tainted: yes/);
  });
}, { running: RUNNING, config: 'taint: { trusted-tools: [read, write, vault_commit] }' }));

test('reading only inside the vaults with trusted tools leaves the session untainted', withInstallation(async (t) => {
  t.repo.write('notes/a.md', 'Alpha.\n');
  t.repo.commit('note');
  t.accept();
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    pi.respond(
      toolCall('read', { path: 'notes/a.md' }),
      toolCall('write', { path: join(t.vault.worktrees, 'gardener', 'b.md'), content: 'B' }),
      toolCall('vault_commit', { message: 'Clean work' }),
      DONE,
    );
    await pi.prompt('Work.');
    assert.doesNotMatch(t.repo.git('log', '-1', '--format=%B', 'refs/heads/actor/gardener'), /Vault-Tainted/);
  });
}, { running: RUNNING, config: 'taint: { trusted-tools: [read, write, vault_commit] }' }));

test('touching a vault path injects its contract once, with the result of the call that touched it', withInstallation(async (t) => {
  t.repo.write('notes/a.md', 'Alpha.\n');
  t.repo.write('notes/_contract.md', '---\nindex: default\n---\nNotes are short.\n');
  t.repo.commit('notes');
  t.accept();
  await withPi(t, {}, async (pi) => {
    pi.respond(toolCall('read', { path: 'notes/a.md' }), toolCall('read', { path: 'notes/a.md' }), DONE);
    await pi.prompt('Read twice.');
    const [first, second] = toolResults(pi.requests.at(-1), 'read');
    assert.match(first ?? '', /Alpha\.[^]*<vault-context source="home:_contract\.md">\nRoot prose\.[^]*source="home:notes\/_contract\.md">\nNotes are short\./);
    assert.doesNotMatch(second ?? '', /vault-context/);
  });
}, { running: RUNNING }));

test('session.start documents are injected before the first request', withInstallation(async (t) => {
  t.repo.write('memory/always.md', '---\napplies-when: [{ on: session.start, effect: inject }]\n---\nBe brief.\n');
  t.repo.commit('memory');
  t.accept();
  await withPi(t, {}, async (pi) => {
    pi.respond(DONE);
    await pi.prompt('Hello.');
    assert.match(JSON.stringify(pi.requests[0]?.messages), /source=\\"home:memory\/always\.md\\">\\nBe brief\./);
  });
}, { running: RUNNING }));

test('a session event that matches a job queues it in the session\'s tree, and says so on the event bus', withInstallation(async (t) => {
  t.repo.write('notes/a.md', 'Alpha.\n');
  t.repo.write('jobs/on-notes.md', '---\napplies-when: [{ on: session.path, paths: ["notes/**"], effect: spawn }]\nbudget: { tokens: 1000, ttl: 10m }\nactor: gardener\n---\nFollow up.\n');
  t.repo.commit('job');
  t.accept();
  await withPi(t, {}, async (pi) => {
    pi.respond(toolCall('read', { path: 'notes/a.md' }), DONE);
    await pi.prompt('Read.');
    const spawns = listSpawns(t.context.state);
    assert.deepEqual(spawns.map((s) => [s.document, s.state, s.depth]), [['jobs/on-notes.md', 'queued', 1]]);
    const requested = pi.events.filter((e) => e.channel === 'pav:v1:spawn').map((e) => e.data as { state: string; trace: string });
    assert.deepEqual(requested.map((r) => [r.state, r.trace]), [['requested', spawns[0]?.trace]]);
    assert.ok(pi.events.some((e) => e.channel === 'pav:v1:event' && (e.data as { kind: string }).kind === 'session.path'));
  });
}, { running: RUNNING }));

test('each turn\'s tokens are recorded against the session\'s budget as it ends', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    pi.respond(toolCall('read', { path: '_contract.md' }), DONE);
    await pi.prompt('Look.');
    const ready = pi.events.find((e) => e.channel === 'pav:v1:ready')?.data as { trace: string };
    const state = budgetState(t.context.state, t.installation.config.budgets, t.clock, ready.trace);
    assert.ok(state !== undefined && state.used > 0, JSON.stringify(state));
  });
}, { running: RUNNING }));
