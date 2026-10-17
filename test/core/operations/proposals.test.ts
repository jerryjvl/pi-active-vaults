// Documented behaviour: cli.md "Proposals" — commit as the current actor with
// checks and trailers; review records the reviewed SHA; accept merges the SHA
// you last reviewed if the merge policy is satisfied; accept --adopt shows the
// concerns and the delta first and needs them acknowledged and confirmed;
// status shows proposals and their checks; sync brings actor branches up to
// date. mcp.md — write changes documents in an actor worktree. Refusals are
// `refused` (exit status 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
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
}));

test('adopting shows the concerns and the delta first, and records nothing until they are acknowledged and confirmed', withInstallation(async (t) => {
  t.repo.write('.vault/scripts/new.sh', scriptSource('new'));
  const tip = t.repo.commit('a control change on main');
  const shown = await t.run('accept', { adopt: tip });
  assert.equal(shown.status, 'refused');
  assert.match(shown.text, /control change: \.vault\/scripts\/new\.sh/);
  const ack = /--acknowledge ([0-9a-f]{64})/.exec(shown.text)?.[1];
  assert.ok(ack !== undefined, shown.text);
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
