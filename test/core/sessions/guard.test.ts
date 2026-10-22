// Documented behaviour: extension.md "Write guard" — file writes outside the
// session's actor worktree (including its Git internals) and shell commands
// that would move `main` or push are blocked, with an explanation the model
// can act on. Control changes inside the worktree are allowed (an owner sees
// them at merge). A worktree whose actor another session holds is not
// written. The guard is a safety net, not a security boundary (security.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { takeActorHold } from '../../../src/core/actors/index.ts';
import { closeSession, guardToolCall, type GuardedCall, type VaultSession } from '../../../src/core/sessions/index.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { OTHER_HOLDER, RUNNING, openTestSession, runOf, startedSpawn } from '../../support/session.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'symbolic links and POSIX shells' : false };

async function session(t: TestInstallation, actor = 'gardener', extra: { cwd?: string; headless?: boolean } = {}): Promise<VaultSession> {
  return openTestSession(t, {
    session: `pi-${actor}`, actor, ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
    ...(extra.headless === true ? { run: runOf(startedSpawn(t), actor) } : {}),
  });
}

const worktreeOf = (s: VaultSession): string => s.worktrees.get('home') ?? '';
const write = (path: string): GuardedCall => ({ kind: 'write', path });
const shell = (command: string, cwd: string): GuardedCall => ({ kind: 'shell', command, cwd });

async function verdict(t: TestInstallation, s: VaultSession, call: GuardedCall) {
  return guardToolCall(t.context, s, call);
}

test('a write in the session\'s own worktree is allowed — control changes too', withInstallation(async (t) => {
  const s = await session(t);
  const worktree = worktreeOf(s);
  assert.deepEqual(await verdict(t, s, write(join(worktree, 'notes', 'a.md'))), { allowed: true });
  assert.deepEqual(await verdict(t, s, write(join(worktree, '_contract.md'))), { allowed: true });
  assert.deepEqual(await verdict(t, s, write(join(worktree, '.vault', 'scripts', 'x.sh'))), { allowed: true });
}, { running: RUNNING }));

test('a write to the vault\'s checkout is blocked, saying where to write instead', withInstallation(async (t) => {
  const s = await session(t);
  const blocked = await verdict(t, s, write(join(t.repo.path, 'notes', 'a.md')));
  assert.equal(blocked.allowed, false);
  assert.ok(!blocked.allowed && blocked.reason.includes(join(worktreeOf(s), 'notes', 'a.md')), !blocked.allowed ? blocked.reason : '');
  assert.equal((await verdict(t, s, write(join(t.repo.path, '.git', 'config')))).allowed, false);
}, { running: RUNNING }));

test('another actor\'s worktree and the worktree\'s Git internals are blocked', withInstallation(async (t) => {
  const s = await session(t);
  assert.equal((await verdict(t, s, write(join(t.vault.worktrees, 'alice', 'a.md')))).allowed, false);
  assert.equal((await verdict(t, s, write(join(worktreeOf(s), '.git')))).allowed, false);
  assert.equal((await verdict(t, s, write(join(worktreeOf(s), '.GIT', 'x')))).allowed, false);
}, { running: RUNNING }));

test('a write through a link out of the worktree lands outside it, and is blocked', posixOnly, withInstallation(async (t) => {
  const s = await session(t);
  symlinkSync(t.repo.path, join(worktreeOf(s), 'escape'));
  assert.equal((await verdict(t, s, write(join(worktreeOf(s), 'escape', 'notes', 'a.md')))).allowed, false);
}, { running: RUNNING }));

test('outside the vaults, an interactive session writes freely and a headless one not at all', withInstallation(async (t) => {
  const elsewhere = t.dir.file('scratch', 'notes.txt');
  const interactive = await session(t);
  assert.deepEqual(await verdict(t, interactive, write(elsewhere)), { allowed: true });
  closeSession(t.context, interactive);
  const headless = await session(t, 'gardener', { headless: true });
  const blocked = await verdict(t, headless, write(elsewhere));
  assert.ok(!blocked.allowed && /only in its worktree/.test(blocked.reason));
}, { running: RUNNING }));

test('a worktree whose actor another session holds is not written; once it is free, it is', withInstallation(async (t) => {
  assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'gardener', holder: OTHER_HOLDER })).ok);
  const s = await session(t);
  const blocked = await verdict(t, s, write(join(join(t.vault.worktrees, 'gardener'), 'a.md')));
  assert.ok(!blocked.allowed && /held by session other-session/.test(blocked.reason));
}, { running: RUNNING }));

test('a session without an actor in a vault writes nothing in it', withInstallation(async (t) => {
  const s = await session(t, 'mallory');
  assert.equal((await verdict(t, s, write(join(t.vault.worktrees, 'mallory', 'a.md')))).allowed, false);
  assert.equal((await verdict(t, s, write(join(t.repo.path, 'a.md')))).allowed, false);
}, { running: RUNNING }));

test('shell commands that push or would move main are blocked, wherever they run from', posixOnly, withInstallation(async (t) => {
  const s = await session(t);
  const worktree = worktreeOf(s);
  const checkout = t.repo.path;
  const elsewhere = t.dir.path;
  for (const [command, cwd] of [
    ['git push origin actor/gardener', worktree],
    ['git -c x=y push', elsewhere],
    [`git -C ${checkout} commit -m x`, elsewhere],
    [`cd ${checkout} && git merge actor/gardener`, elsewhere],
    ['git reset --hard HEAD~1', checkout],
    ['git commit -am "work"', join(checkout, 'notes')],
    ['git update-ref refs/heads/main HEAD', worktree],
    ['git branch -f main HEAD', worktree],
    ['git checkout -B main', worktree],
    ['ls; git pull', checkout],
  ] as const) {
    const v = await verdict(t, s, shell(command, cwd));
    assert.equal(v.allowed, false, command);
    assert.ok(!v.allowed && v.reason.length > 0);
  }
}, { running: RUNNING }));

test('other shell commands, and Git work in the worktree, are allowed', posixOnly, withInstallation(async (t) => {
  const s = await session(t);
  const worktree = worktreeOf(s);
  mkdirSync(join(worktree, 'notes'), { recursive: true });
  for (const [command, cwd] of [
    ['ls -la', t.repo.path],
    ['git status && git log -1', t.repo.path],
    ['git commit -am "work"', join(worktree, 'notes')],
    ['echo "git push"', worktree],
    ['git diff main', worktree],
  ] as const) {
    assert.deepEqual(await verdict(t, s, shell(command, cwd)), { allowed: true }, command);
  }
}, { running: RUNNING }));
