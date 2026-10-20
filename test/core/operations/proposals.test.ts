// Documented behaviour: cli.md "Proposals" — commit as the current actor with
// checks and trailers; review records the reviewed SHA; accept merges the SHA
// you last reviewed if the merge policy is satisfied; accept --adopt shows the
// concerns and the delta first and needs them acknowledged and confirmed;
// status shows proposals and their checks; sync brings actor branches up to
// date. mcp.md — write changes documents in an actor worktree. Refusals are
// `refused` (exit status 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { allot } from '../../../src/core/budgets/index.ts';
import { listSpawns } from '../../../src/core/queue/index.ts';
import { scriptSource } from '../../support/vault.ts';
import { withInstallation, writeFiles, type TestInstallation } from '../../support/installation.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };
const worktree = (t: TestInstallation, actor = 'gardener') => join(t.vault.worktrees, actor);

/** A first commit as gardener makes its worktree; then files are written and committed. */
async function commitAs(t: TestInstallation, files: Record<string, string>, message = 'Work'): Promise<ReturnType<TestInstallation['run']>> {
  await t.run('write', { path: '.keep-worktree.md', content: 'x', actor: 'gardener' }, { surface: 'mcp' });
  writeFiles(worktree(t), files);
  return t.run('commit', { message, actor: 'gardener' });
}

test('a commit as an actor runs the checks and lands with the package\'s trailers; a failing check refuses it', posixOnly, withInstallation(async (t) => {
  t.repo.write('.vault/checks/no-todo.sh', scriptSource('no-todo', 'if grep -rq TODO notes 2>/dev/null; then echo "TODO left"; exit 1; fi'));
  t.repo.commit('a check');
  t.accept();
  const refused = await commitAs(t, { 'notes/a.md': 'TODO' });
  assert.equal(refused.status, 'refused');
  assert.match(refused.text, /no-todo: fail — TODO left/);

  writeFiles(worktree(t), { 'notes/a.md': 'Done.' });
  const committed = await t.run('commit', { message: 'Finished', actor: 'gardener' });
  assert.equal(committed.status, 'ok', committed.text);
  const message = t.repo.git('log', '-1', '--format=%B', 'refs/heads/actor/gardener');
  assert.match(message, /^Finished\n\nVault-Trace: [0-9A-Z]{26}\nVault-Actor: gardener$/);
  assert.equal(t.repo.git('log', '-1', '--format=%an <%ae>', 'refs/heads/actor/gardener'), 'gardener <gardener@homeserver>');
}));

test('a commit is refused while main has an unaccepted change', withInstallation(async (t) => {
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  const refused = await t.run('commit', { message: 'x', actor: 'gardener' });
  assert.equal(refused.status, 'refused');
}));

test('review records the reviewed commit; accept merges it once the policy is met, and only for an owner who reviewed it', withInstallation(async (t) => {
  assert.equal((await commitAs(t, { 'notes/a.md': 'A' })).status, 'ok');
  const notReviewed = await t.run('accept', { actor: 'gardener' });
  assert.equal(notReviewed.status, 'refused');
  assert.match(notReviewed.text, /has not reviewed/);

  const reviewed = await t.run('review', { actor: 'gardener' });
  assert.equal(reviewed.status, 'ok', reviewed.text);
  assert.match(reviewed.text, /Proposal from gardener: 1 commit\(s\)/);
  assert.match(reviewed.text, /created notes\/a\.md/);
  assert.match(reviewed.text, /Recorded as alice's review of [0-9a-f]{40}\./);

  const stranger = await t.run('accept', { actor: 'gardener' }, { caller: { person: 'mallory' } });
  assert.equal(stranger.status, 'refused');
  const accepted = await t.run('accept', { actor: 'gardener' });
  assert.equal(accepted.status, 'ok', accepted.text);
  assert.equal(readFileSync(join(t.repo.path, 'notes', 'a.md'), 'utf8'), 'A');
  assert.equal((await t.run('status')).text.includes('proposal from gardener'), false, 'nothing is pending afterwards');
}));

test('status shows each pending proposal with its checks and what the policy still needs', withInstallation(async (t) => {
  t.repo.write('_contract.md', `${readFileSync(join(t.repo.path, '_contract.md'), 'utf8').replace('---\nRoot', 'merge:\n  - { paths: ["**"], require: [owner] }\n---\nRoot')}`);
  t.repo.commit('policy');
  t.accept();
  assert.equal((await commitAs(t, { 'notes/a.md': 'A' })).status, 'ok');
  const status = await t.run('status');
  assert.match(status.text, /proposal from gardener: 1 commit\(s\), head [0-9a-f]{40}/);
  assert.match(status.text, /unmet owner: no owner has approved this commit/);
  assert.match(status.text, /merge policy met once an owner accepts it/, "an owner's approval alone is not shown as a failure");
  assert.doesNotMatch(status.text, /not satisfied/);
}));

test('status shows where the installation person works in each vault — not to a remote client, which has no use for a machine path', withInstallation(async (t) => {
  const status = await t.run('status');
  assert.ok(status.text.includes(`your worktree: ${worktree(t, 'alice')}`), status.text);
  const vaults = (status.data as { vaults: { worktree?: string }[] }).vaults;
  assert.equal(vaults[0]?.worktree, worktree(t, 'alice'));
  const remote = await t.run('status', {}, { caller: { surface: 'mcp' }, surface: 'mcp' });
  assert.ok(!remote.text.includes('your worktree'));
  assert.equal((remote.data as { vaults: { worktree?: string }[] }).vaults[0]?.worktree, undefined);
}));

test('adopting shows the concerns and the delta first, and records nothing until they are acknowledged and confirmed', withInstallation(async (t) => {
  t.repo.write('.vault/scripts/new.sh', scriptSource('new'));
  const tip = t.repo.commit('a control change on main');
  const shown = await t.run('accept', { adopt: tip });
  assert.equal(shown.status, 'refused');
  assert.match(shown.text, /control change: \.vault\/scripts\/new\.sh/);
  const ack = /--acknowledge ([0-9a-f]{64})/.exec(shown.text)?.[1];
  assert.ok(ack !== undefined, shown.text);
  // What a surface with someone to ask shows, asks, and confirms with.
  assert.match(shown.confirm?.shown ?? '', /control change: \.vault\/scripts\/new\.sh[^]*Commits:/);
  assert.doesNotMatch(shown.confirm?.shown ?? '', /Not adopted yet/);
  assert.match(shown.confirm?.question ?? '', new RegExp(`Adopt ${tip} .*acknowledging the concerns`));
  assert.deepEqual(shown.confirm?.params, { yes: true, acknowledge: ack });
  const unacknowledged = await t.run('accept', { adopt: tip, yes: true });
  assert.equal(unacknowledged.status, 'refused');
  const adopted = await t.run('accept', { adopt: tip, acknowledge: ack, yes: true });
  assert.equal(adopted.status, 'ok', adopted.text);
  assert.match(adopted.text, new RegExp(`Adopted ${tip}`));
}));

test('write puts a document in the actor\'s worktree and nowhere else', withInstallation(async (t) => {
  const written = await t.run('write', { path: 'notes/new.md', content: '# New\n', actor: 'gardener' }, { surface: 'mcp' });
  assert.equal(written.status, 'ok', written.text);
  assert.equal(readFileSync(join(worktree(t), 'notes', 'new.md'), 'utf8'), '# New\n');
  for (const path of ['../outside.md', '/etc/passwd', '.git/hooks/pre-commit', '.GIT/config', 'notes/../../escape.md']) {
    const refused = await t.run('write', { path, content: 'x', actor: 'gardener' }, { surface: 'mcp' });
    assert.equal(refused.status, 'refused', path);
  }
  if (process.platform !== 'win32') {
    symlinkSync(t.dir.path, join(worktree(t), 'link'));
    const viaLink = await t.run('write', { path: 'link/escaped.md', content: 'x', actor: 'gardener' }, { surface: 'mcp' });
    assert.equal(viaLink.status, 'refused');
    assert.equal(existsSync(join(t.dir.path, 'escaped.md')), false);
  }
}));

test('write and commit are refused while another session holds the actor', withInstallation(async (t) => {
  const { takeActorHold } = await import('../../../src/core/actors/index.ts');
  const holder = { process: { pid: 42, started: 'start' }, session: 'S-other' };
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'gardener', holder })).ok);
  const write = await t.run('write', { path: 'a.md', content: 'x', actor: 'gardener' }, { surface: 'mcp' });
  assert.equal(write.status, 'refused');
  assert.match(write.text, /held by session S-other \(process 42\)/);
}, { running: { 42: 'start' } }));

test('sync brings an actor branch with no work of its own up to the accepted main', withInstallation(async (t) => {
  await t.run('write', { path: 'a.md', content: 'x', actor: 'gardener' }, { surface: 'mcp' });
  t.repo.write('news.md', 'news');
  const sha = t.repo.commit('news');
  t.accept(sha);
  const synced = await t.run('sync', {});
  assert.equal(synced.status, 'ok', synced.text);
  assert.match(synced.text, new RegExp(`gardener: fast-forwarded at ${sha}`));
}));

test('sync of a branch that conflicts with the accepted main says what conflicts and how to resolve it, and changes nothing', withInstallation(async (t) => {
  t.repo.write('a.md', 'base');
  t.accept(t.repo.commit('base'));
  await t.run('write', { path: 'a.md', content: 'the gardener', actor: 'gardener' }, { surface: 'mcp' });
  const made = await t.run('commit', { message: 'gardener edit', actor: 'gardener' });
  assert.equal(made.status, 'ok', made.text);
  const head = t.repo.git('rev-parse', 'refs/heads/actor/gardener');
  t.repo.write('a.md', 'main');
  t.accept(t.repo.commit('main edit'));
  const synced = await t.run('sync', { actor: 'gardener' });
  assert.notEqual(synced.status, 'ok');
  assert.match(synced.text, /actor\/gardener .*conflicts with the accepted main .* in: a\.md/);
  assert.match(synced.text, /git merge [0-9a-f]{40}/);
  assert.equal(t.repo.git('rev-parse', 'refs/heads/actor/gardener'), head, 'nothing changed');
}));

test('undelivered notifications, being the whole installation\'s, are shown by status only on local surfaces', withInstallation(async (t) => {
  const { sendNotification } = await import('../../../src/core/notify/index.ts');
  const config = t.installation.notify;
  assert.ok(config !== undefined);
  const sent = await sendNotification({ store: t.context.state, config, clock: t.clock, secrets: t.context.secrets, env: {} }, { to: 'me', subject: 'Private matter', body: 'x', trace: '01JABCDEFGHJKMNPQRSTVWXYZ0' });
  assert.equal(sent.ok && sent.value.outcome, 'queued');
  assert.match((await t.run('status')).text, /Undelivered notifications: me "Private matter"/);
  const remote = await t.run('status', {}, { caller: { surface: 'mcp' }, surface: 'mcp' });
  assert.equal(remote.text.includes('Private matter'), false);
  assert.deepEqual((remote.data as { undelivered: unknown[] }).undelivered, []);
}, { config: 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { me: me@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }' }));

const WATCH_JOB = '---\napplies-when: [{ on: committed, actor: [gardener], effect: spawn }]\nbudget: { tokens: 1000, ttl: 10m }\nactor: gardener\n---\nTidy what gardener did.\n';

test('a commit made from a session carries its trace, and requests the spawns its event matches in that session\'s tree', withInstallation(async (t) => {
  t.repo.write('jobs/tidy.md', WATCH_JOB);
  t.repo.commit('a job');
  t.accept();
  const session = '01JSESSIONTRACE0000000000A';
  t.context.state.transaction((tx) => allot(tx, t.installation.config.budgets, t.clock, { trace: session, budget: { tokens: 100_000, ttlMs: 0 } }));
  await t.run('write', { path: 'notes/a.md', content: 'A', actor: 'gardener' }, { surface: 'mcp' });
  const committed = await t.run('commit', { message: 'Work' }, { caller: { surface: 'pi', actor: 'gardener', session: 'pi-1', trace: session } });
  assert.equal(committed.status, 'ok', committed.text);
  const sha = (committed.data as { sha: string }).sha;
  assert.match(t.repo.git('log', '-1', '--format=%B', sha), new RegExp(`Vault-Trace: ${session}`));
  const spawns = listSpawns(t.context.state);
  assert.deepEqual(spawns.map((s) => [s.document, s.state, s.parent, s.root]), [['jobs/tidy.md', 'queued', session, session]]);
  assert.equal((spawns[0]?.event as { kind: string; commit: string }).commit, sha);
  assert.match(committed.text, /Queued home:jobs\/tidy\.md/);
}));

test('a commit outside a session starts a new tree for what it spawns', withInstallation(async (t) => {
  t.repo.write('jobs/tidy.md', WATCH_JOB);
  t.repo.commit('a job');
  t.accept();
  assert.equal((await commitAs(t, { 'notes/a.md': 'A' })).status, 'ok');
  const spawns = listSpawns(t.context.state);
  assert.deepEqual(spawns.map((s) => [s.document, s.state, s.parent, s.depth]), [['jobs/tidy.md', 'queued', undefined, 0]]);
}));

// concepts.md "Models": nothing missing stops anything else, but it is visible — `status` lists the jobs that cannot run for lack of a model.
test('status lists the jobs that cannot run for lack of an agent model', withInstallation(async (t) => {
  t.repo.write('jobs/ok.md', '---\napplies-when: [{ on: external, name: go, effect: spawn }]\nbudget: { tokens: 500, ttl: 2m }\nactor: gardener\n---\nGo.\n');
  t.repo.write('jobs/quick.md', '---\napplies-when: [{ on: external, name: go, effect: spawn }]\nbudget: { tokens: 500, ttl: 2m }\nactor: gardener\nmodel: quick\n---\nGo.\n');
  t.repo.commit('jobs');
  t.accept();
  const status = await t.run('status');
  assert.equal(status.status, 'ok');
  assert.match(status.text, /cannot run: jobs\/quick\.md \(no agent model it may use: the policy does not allow "quick" for home\)/);
  assert.doesNotMatch(status.text, /cannot run: jobs\/ok\.md/);
  const vault = (status.data as { vaults: { unrunnable: { document: string }[] }[] }).vaults[0];
  assert.deepEqual(vault?.unrunnable.map((u) => u.document), ['jobs/quick.md']);
}, { noDefaultModels: true, config: 'models:\n  agent: { model: p/big }\n  quick: { role: agent, model: p/small }\npolicy:\n  - { vaults: [home], allow-models: [agent] }' }));
