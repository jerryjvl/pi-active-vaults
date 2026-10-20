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
import { execFileSync } from 'node:child_process';

const runGit = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
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

test('a local vault backed up to a remote: doctor says what to do while the clone lacks it, and it is not a stray remote once added; sync pushes', withInstallation(async (t) => {
  const missing = about((await findings(t)).found, 'backup');
  assert.deepEqual(missing.map((f) => f.level), ['warning']);
  assert.match(missing[0]?.message ?? '', /backed up to the Git remote "backup", which this clone does not have[^]*remote add backup <its URL>/);
  const bare = t.dir.file('backup.git');
  runGit(['init', '--quiet', '--bare', bare]);
  t.repo.git('remote', 'add', 'backup', bare);
  const { found } = await findings(t);
  assert.deepEqual(about(found, 'backup').map((f) => f.level), ['ok']);
  assert.deepEqual(about(found, 'remotes'), [], 'its backup remote is expected');
  const synced = await t.run('sync', {}, { vaults: ['home'] });
  assert.match(synced.text, /Backed up to "backup" \(\d+ refs\)\./);
  assert.equal(runGit(['-C', bare, 'rev-parse', 'refs/heads/main']), t.repo.git('rev-parse', 'main'));
}, { remote: 'backup' }));

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
  const jobs = about((await findings(t)).found, 'jobs').filter((f) => f.message.includes('cannot run'));
  assert.deepEqual(jobs.map((f) => f.level), ['warning']);
  assert.match(jobs[0]?.message ?? '', /jobs\/actorless\.md cannot run: actor: is required/);
}));

const BELL = '---\napplies-when:\n  - { on: external, name: bell, effect: spawn }\nactor: gardener\nbudget: { tokens: 500, ttl: 2m }\n---\n';
const whereJobsRun = async (t: TestInstallation) => {
  t.repo.write('jobs/bell.md', BELL);
  t.repo.commit('job');
  t.accept();
  return about((await findings(t)).found, 'jobs').map((f) => [f.level, f.message]);
};

test('doctor says where a vault\'s jobs run: here when hosted here', withInstallation(async (t) => {
  assert.deepEqual(await whereJobsRun(t), [['ok', '1 job runs here (host: true).']]);
}, { host: true }));

test('doctor says where a vault\'s jobs run: on the executor the contract names, which is no warning', withInstallation(async (t) => {
  assert.deepEqual(await whereJobsRun(t), [['ok', '1 job runs on vaults@studio, the vault\'s executor, not here.']]);
}, { contract: { executor: 'vaults@studio' } }));

test('doctor warns when a vault has jobs but names no executor and is not hosted here: they may run nowhere', withInstallation(async (t) => {
  const found = await whereJobsRun(t);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.[0], 'warning');
  assert.match(found[0]?.[1] ?? '', /^1 job, but it does not run here: the vault names no executor and host is not true/);
}));

test('doctor says nothing of where jobs run when a vault has none', withInstallation(async (t) => {
  assert.deepEqual(about((await findings(t)).found, 'jobs'), []);
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

test('a forge that shows main\'s protection only to admins: a warning to check it by hand, and the merge settings still checked', withForgeInstallation(async (t, forge) => {
  forge.stub.model.protection = 'forbidden';
  forge.stub.model.repository = { allow_squash_merge: true, allow_rebase: false, allow_rebase_explicit: false };
  const found = about((await findings(t)).found, 'forge').map((f) => [f.level, f.message]);
  assert.deepEqual(found.map(([level]) => level), ['warning', 'problem']);
  assert.match(found[0]?.[1] ?? '', /cannot be read with the executor's access[^]*check it by hand/);
  assert.match(found[1]?.[1] ?? '', /Squash merges are allowed/);
}));

// cli.md `vault doctor`: models — requested names that are not configured (and the default that answers
// instead), names with the wrong role, defaults that documents need but are missing, and models the policy
// does not allow where they are asked for; and the jobs that cannot run for lack of an agent model.
const JOB = (extra = '') => `---\napplies-when:\n  - { on: external, name: go, effect: spawn }\nbudget: { tokens: 500, ttl: 2m }\nactor: gardener\n${extra}---\nGo.\n`;
const JUDGE = 'url: "https://models.example.net/v1", token: "${T}", model: j';
const AXIS = (model = '') => `axes:\n  evidence:\n    type: bool\n${model === '' ? '' : `    model: ${model}\n`}    instructions: Backed?\n    true: Yes\n    false: No\n    pass-when: { value: true, probability: 0.8 }\n`;
const models = (entries: string, allowed: string[]) => ({ noDefaultModels: true, config: `models:\n${entries}\npolicy:\n  - { vaults: [home], allow-models: [${allowed.join(', ')}] }` });

test('doctor says when a job or an axis asks for a model that is not configured, and which default answers instead', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', JOB('model: telepathy\n'));
  t.repo.write('topics/_contract.md', `---\n${AXIS('telepathy')}---\n`);
  t.repo.commit('documents');
  t.accept();
  const found = about((await findings(t)).found, 'models').filter((f) => f.vault === 'home');
  assert.deepEqual(found.map((f) => f.level), ['warning', 'warning']);
  assert.match(found[0]?.message ?? '', /jobs\/a\.md asks for the agent model "telepathy", which is not configured; the default "agent" answers instead/);
  assert.match(found[1]?.message ?? '', /axis evidence \(topics\/_contract\.md\) asks for the judgement model "telepathy", which is not configured; the default "judgement" answers instead/);
}, models(`  agent: { model: p/big }\n  judgement: { ${JUDGE} }`, ['agent', 'judgement'])));

test('doctor reports a name with the wrong role, which the default does not answer', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', JOB('model: judge\n'));
  t.repo.write('topics/_contract.md', `---\n${AXIS('quick')}---\n`);
  t.repo.commit('documents');
  t.accept();
  const found = about((await findings(t)).found, 'models').filter((f) => f.vault === 'home');
  assert.match(found[0]?.message ?? '', /jobs\/a\.md asks for "judge", which is a judgement model, not an agent model; it cannot run/);
  assert.match(found[1]?.message ?? '', /axis evidence \(topics\/_contract\.md\) asks for "quick", which is an agent model, not a judgement model; it stays unjudged/);
  assert.match(about((await findings(t)).found, 'jobs').map((f) => f.message).join('\n'), /jobs\/a\.md cannot run: no agent model it may use/);
}, models(`  agent: { model: p/big }\n  quick: { role: agent, model: p/small }\n  judgement: { ${JUDGE} }\n  judge: { role: judgement, ${JUDGE} }`, ['agent', 'quick', 'judgement', 'judge'])));

test('doctor reports a default that documents need but is missing, once per role, and the jobs that cannot run without it', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', JOB());
  t.repo.write('jobs/b.md', JOB('model: quick\n'));
  t.repo.write('topics/_contract.md', `---\n${AXIS()}---\n`);
  t.repo.commit('documents');
  t.accept();
  const { found } = await findings(t);
  const missing = about(found, 'models').filter((f) => f.vault === 'home');
  assert.equal(missing.length, 2);
  assert.match(missing[0]?.message ?? '', /the default agent model is not configured, which jobs\/a\.md needs; it cannot run/);
  assert.match(missing[1]?.message ?? '', /the default judgement model is not configured, which axis evidence \(topics\/_contract\.md\) needs; it stays unjudged/);
  const cannot = about(found, 'jobs').map((f) => f.message).filter((m) => m.includes('cannot run'));
  assert.equal(cannot.length, 1, 'jobs/b.md asks for a model that is configured and allowed, so it can run');
  assert.match(cannot[0] ?? '', /jobs\/a\.md cannot run: no agent model it may use/);
}, models(`  quick: { role: agent, model: p/small }`, ['quick'])));

test('doctor reports a configured model the policy does not allow where it is asked for, and no replacement', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', JOB('model: quick\n'));
  t.repo.write('jobs/b.md', JOB());
  t.repo.commit('documents');
  t.accept();
  const { found } = await findings(t);
  const refused = about(found, 'models').filter((f) => f.vault === 'home');
  assert.equal(refused.length, 1, 'jobs/b.md uses the allowed default');
  assert.match(refused[0]?.message ?? '', /jobs\/a\.md: the policy does not allow the agent model "quick" for this vault, and the default does not take its place; it cannot run/);
  assert.match(about(found, 'jobs').map((f) => f.message).join('\n'), /jobs\/a\.md cannot run: no agent model it may use/);
}, models(`  agent: { model: p/big }\n  quick: { role: agent, model: p/small }`, ['agent'])));

test('doctor says nothing of models when documents ask for nothing unusual', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', JOB('model: quick\n'));
  t.repo.commit('documents');
  t.accept();
  const { found } = await findings(t);
  assert.deepEqual(about(found, 'models').filter((f) => f.vault === 'home'), []);
  assert.deepEqual(about(found, 'jobs').filter((f) => f.message.includes('cannot run')), []);
}, models(`  agent: { model: p/big }\n  quick: { role: agent, model: p/small }`, ['agent', 'quick'])));

test('doctor warns of a policy that names a model that is not configured, as a typo would', withInstallation(async (t) => {
  const { found } = await findings(t);
  const policy = about(found, 'models').filter((f) => f.vault === undefined && f.level === 'warning');
  assert.equal(policy.length, 1);
  assert.match(policy[0]?.message ?? '', /policy allows "agnet" for home, but no model of that name is configured/);
}, models(`  agent: { model: p/big }`, ['agent', 'agnet'])));

test('doctor lists each configured model; an agent model needs no token', withInstallation(async (t) => {
  const { found } = await findings(t);
  const listed = about(found, 'models').map((f) => f.message);
  assert.ok(listed.some((m) => /^agent: agent model p\/big, as Pi names it/.test(m)), listed.join('\n'));
  assert.ok(listed.some((m) => /^judge: judgement model j at https:\/\/models\.example\.net\/v1; its token resolves/.test(m)), listed.join('\n'));
}, { ...models(`  agent: { model: p/big }\n  judge: { role: judgement, ${JUDGE} }`, ['agent', 'judge']), env: { T: 'secret' } }));

test('config and state are private enough when they are the user\'s alone, or managed by root for a service user\'s group', async () => {
  const { privateEnough } = await import('../../../src/core/operations/ops/doctor.ts');
  assert.equal(privateEnough({ mode: 0o100600, uid: 501 }), true, 'the user\'s alone');
  assert.equal(privateEnough({ mode: 0o040700, uid: 501 }), true);
  assert.equal(privateEnough({ mode: 0o100640, uid: 0 }), true, 'root\'s, readable by the service user\'s group');
  assert.equal(privateEnough({ mode: 0o040750, uid: 0 }), true);
  assert.equal(privateEnough({ mode: 0o100640, uid: 501 }), false, 'a group may read only what root manages');
  assert.equal(privateEnough({ mode: 0o100660, uid: 0 }), false, 'never writable by the group');
  assert.equal(privateEnough({ mode: 0o100644, uid: 0 }), false, 'never readable by everyone');
});
