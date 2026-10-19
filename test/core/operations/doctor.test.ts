// Documented behaviour: cli.md `vault doctor` and security-setup.md — it
// checks config, Git, Pi, model endpoints, hooks (including a core.hooksPath
// that bypasses them), paths and forge settings, and reports a local vault
// with a remote, sessions holding an actor, and a leftover Git lock in main's
// worktree; `--fix` installs hooks and corrects permissions. It also reports
// a hold whose holder cannot be told, with its process and session,
// undelivered notifications, keyword-only search because no policy entry
// names a vault, and no budgets.daily-tokens; and in forge mode, squash or
// rebase merges allowed — or, where the forge's API does not show the merge
// methods to the executor, that it cannot verify them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeActorHold } from '../../../src/core/actors/index.ts';
import { listSpawns, takeDaemonRecord } from '../../../src/core/queue/index.ts';
import { runProcess } from '../../../src/core/process/index.ts';
import { withForgeInstallation } from '../../support/forge-vault.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { RUNNING, startedSpawn } from '../../support/session.ts';

const live: Record<number, string> = { ...RUNNING, 9: 's' };

type Finding = { level: string; check: string; vault?: string; message: string };
const findings = async (t: TestInstallation, params: Record<string, unknown> = {}) => {
  const outcome = await t.run('doctor', params);
  return { outcome, found: (outcome.data as { findings: Finding[] }).findings };
};
const about = (found: Finding[], check: string) => found.filter((f) => f.check === check);

test('doctor reports a hooks path that bypasses the hooks, a remote on a local vault, a lock left in main\'s worktree', withInstallation(async (t) => {
  t.repo.git('config', 'core.hooksPath', '/elsewhere');
  t.repo.git('remote', 'add', 'origin', 'https://git.example.net/home/vault.git');
  writeFileSync(join(t.repo.path, '.git', 'index.lock'), '');
  const { outcome, found } = await findings(t);
  assert.equal(outcome.status, 'failed', 'a problem fails the command');
  assert.match(about(found, 'hooks')[0]?.message ?? '', /core\.hooksPath \(\/elsewhere\) bypasses the package's hooks/);
  assert.match(about(found, 'remotes')[0]?.message ?? '', /A local vault has remotes \(origin\)/);
  assert.deepEqual(about(found, 'locks').map((f) => f.level), ['problem']);
}));

test('doctor warns of keyword-only search, no daily ceiling, notify unconfigured, and undelivered notifications', withInstallation(async (t) => {
  const { found } = await findings(t);
  assert.match(about(found, 'search')[0]?.message ?? '', /keyword-only: no policy entry allows the embed model for this vault/);
  assert.match(about(found, 'budgets')[0]?.message ?? '', /budgets\.daily-tokens is not set/);
  assert.match(about(found, 'notify')[0]?.message ?? '', /notify is not configured/);
}, { noDefaultModels: true, config: 'models:\n  embed: { url: "https://models.example.net/v1", token: "${EMBED_TOKEN}", model: e }' }));

test('doctor lists sessions holding actors, and says which stand only because their process cannot be told apart', withInstallation(async (t) => {
  for (const [actor, pid] of [['gardener', 7], ['alice', 8]] as const) {
    assert.ok((await takeActorHold(t.context.state, async () => ({ ok: true, value: 's' }), t.clock, { vault: 'home', actor, holder: { process: { pid, started: 's' }, session: `S-${actor}` } })).ok);
  }
  const holds = about((await findings(t)).found, 'holds');
  assert.deepEqual(holds.map((h) => h.level), ['warning', 'ok']);
  assert.match(holds[0]?.message ?? '', /alice is held by session S-alice: process 8 exists, but whether it is that session cannot be told/);
  assert.match(holds[1]?.message ?? '', /gardener is held by session S-gardener \(process 7\)/);
}, { running: { 7: 's' }, unknown: [8] }));

test('doctor --fix installs the pre-push guard, which refuses a push of main, and makes the state private', { skip: process.platform === 'win32' ? 'POSIX hook and modes' : false }, withInstallation(async (t) => {
  const hook = join(t.repo.path, '.git', 'hooks', 'pre-push');
  assert.match(about((await findings(t)).found, 'hooks')[0]?.message ?? '', /not installed/);
  chmodSync(t.installation.paths.stateDb, 0o644);
  assert.deepEqual(about((await findings(t)).found, 'permissions').map((f) => f.level), ['problem']);
  await findings(t, { fix: true });
  assert.ok(existsSync(hook));
  assert.equal(statSync(t.installation.paths.stateDb).mode & 0o777, 0o600);
  assert.match(about((await findings(t)).found, 'hooks')[0]?.message ?? '', /is installed/);

  const push = (line: string) => runProcess({ program: { file: '/bin/sh', args: [hook, 'origin', 'url'] }, env: { PATH: process.env['PATH'] ?? '' }, input: line, timeoutMs: 5000, maxStdoutBytes: 1024, maxStderrBytes: 1024 });
  const zero = '0'.repeat(40);
  const main = await push(`refs/heads/main ${'1'.repeat(40)} refs/heads/main ${zero}\n`);
  assert.equal(main.ok && main.value.exitCode, 1);
  const actor = await push(`refs/heads/actor/gardener ${'1'.repeat(40)} refs/heads/actor/gardener ${zero}\n`);
  assert.equal(actor.ok && actor.value.exitCode, 0);

  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  assert.match(about((await findings(t, { fix: true })).found, 'hooks')[0]?.message ?? '', /pre-push hook of its own/);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n', 'a hook of the user\'s is never replaced');
}));

test('doctor reports a job that cannot run, with why', withInstallation(async (t) => {
  t.repo.write('jobs/actorless.md', '---\napplies-when:\n  - { on: external, name: bell, effect: spawn }\nbudget: { tokens: 500, ttl: 2m }\n---\n');
  t.repo.commit('job');
  t.accept();
  const jobs = about((await findings(t)).found, 'jobs');
  assert.deepEqual(jobs.map((f) => f.level), ['warning']);
  assert.match(jobs[0]?.message ?? '', /jobs\/actorless\.md cannot run: actor: is required/);
}));

// daemon.md "Responsibilities": a reference-transaction hook in each vault
// tells the daemon of ref updates; cli.md `vault doctor --fix` installs hooks
// where none of the user's is in the way, and runs start-up recovery when no
// daemon is running; doctor checks the daemon.
test('doctor --fix installs the refs hook, which tells the daemon a vault\'s refs changed, only once they have', { skip: process.platform === 'win32' ? 'POSIX hook' : false }, withInstallation(async (t) => {
  const hook = join(t.repo.path, '.git', 'hooks', 'reference-transaction');
  assert.match(about((await findings(t)).found, 'hooks').map((f) => f.message).join('\n'), /refs hook is not installed/);
  await findings(t, { fix: true });
  assert.ok(existsSync(hook));
  const word = join(t.installation.paths.refs, 'home');
  const run = (state: string) => runProcess({ program: { file: '/bin/sh', args: [hook, state] }, env: { PATH: process.env['PATH'] ?? '' }, input: 'x y refs/heads/main\n', timeoutMs: 5000, maxStdoutBytes: 1024, maxStderrBytes: 1024 });
  assert.equal((await run('prepared')).ok, true);
  assert.equal(existsSync(word), false, 'nothing until the transaction is committed');
  const committed = await run('committed');
  assert.equal(committed.ok && committed.value.exitCode, 0);
  assert.ok(existsSync(word));
  t.repo.write('n.md', 'a real commit runs it');
  rmSync(word);
  t.repo.commit('n');
  assert.ok(existsSync(word));
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  assert.match(about((await findings(t, { fix: true })).found, 'hooks').map((f) => f.message).join('\n'), /reference-transaction hook of its own/);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
}));

test('doctor says whether a daemon runs', withInstallation(async (t) => {
  assert.deepEqual(about((await findings(t)).found, 'daemon').map((f) => f.level), ['warning']);
  assert.ok((await takeDaemonRecord(t.context.state, t.context.alive, t.clock, { pid: 9, started: 's' })).ok);
  const running = about((await findings(t)).found, 'daemon');
  assert.deepEqual(running.map((f) => f.level), ['ok']);
  assert.match(running[0]?.message ?? '', /process 9/);
}, { running: { 9: 's' } }));

test('doctor --fix runs start-up recovery when no daemon runs, and leaves it to a daemon that does', withInstallation(async (t) => {
  const entry = startedSpawn(t);
  assert.ok((await takeDaemonRecord(t.context.state, t.context.alive, t.clock, { pid: 9, started: 's' })).ok);
  await findings(t, { fix: true });
  assert.equal(listSpawns(t.context.state)[0]?.state, 'running', 'a running daemon owns it');
  delete live[9];
  const fixed = about((await findings(t, { fix: true })).found, 'recovery');
  assert.deepEqual(listSpawns(t.context.state).map((s) => [s.id, s.state, s.reason]), [[entry.id, 'stopped', 'restart']]);
  assert.match(fixed[0]?.message ?? '', /1 run/);
}, { running: live }));

test('doctor checks the forge\'s merge methods: squash or rebase merges allowed are problems, settings it cannot read a warning', withForgeInstallation(async (t, forge) => {
  forge.stub.model.protection = { enable_push: false, enable_force_push: false, enable_status_check: true, status_check_contexts: ['vault/policy'], required_approvals: 1 };
  const forgeFindings = async () => about((await findings(t)).found, 'forge').map((f) => [f.level, f.message]);

  forge.stub.model.repository = { allow_squash_merge: false, allow_rebase: false, allow_rebase_explicit: false };
  assert.deepEqual(await forgeFindings(), [['ok', 'Main is protected as recommended.']]);

  forge.stub.model.repository = { allow_squash_merge: false, allow_rebase: false, allow_rebase_explicit: true };
  const rebase = await forgeFindings();
  assert.deepEqual(rebase.map(([level]) => level), ['problem']);
  assert.match(rebase[0]?.[1] ?? '', /Rebase merges are allowed: they replace a proposal's commits with new ones/);

  forge.stub.model.repository = { allow_squash_merge: true, allow_rebase: true };
  assert.deepEqual((await forgeFindings()).map(([level]) => level), ['problem', 'problem']);

  forge.stub.model.repository = { allow_squash_merge: false };
  const unknown = await forgeFindings();
  assert.deepEqual(unknown.map(([level]) => level), ['warning'], 'what the API does not show is not a fault');
  assert.match(unknown[0]?.[1] ?? '', /cannot verify whether rebase merges are allowed/i);

  forge.stub.model.repository = 'forbidden';
  const unreadable = await forgeFindings();
  assert.deepEqual(unreadable.map(([level]) => level), ['warning'], 'settings the executor may not read are a warning, not a failure');
  assert.match(unreadable[0]?.[1] ?? '', /cannot verify whether squash and rebase merges are allowed \(http-error\)/i);
}));
