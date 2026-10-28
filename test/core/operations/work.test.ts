// Documented behaviour: cli.md "Work" — `jobs` lists jobs with their
// conditions and runs; `run` runs a job now, outside its conditions;
// `trigger` emits an external event; `script` runs an approved script;
// `notify` sends to an alias; `trace` shows a trace. architecture.md
// "Degradation" — without the daemon, spawns are claimed in the state
// database for it to run. security.md — these propagate, so they are refused
// for a vault whose main has an unaccepted change.
import { test } from 'node:test';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { claimScratch } from '../../../src/core/config/index.ts';
import { listSpawns } from '../../../src/core/queue/index.ts';
import { TRACES_REF, renderCompactTrace } from '../../../src/core/traces/index.ts';
import { scriptSource } from '../../support/vault.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };

function jobs(t: TestInstallation): void {
  t.repo.write('jobs/daily.md', '---\napplies-when:\n  - { on: timer, schedule: "30 6 * * *", effect: spawn }\nbudget: { tokens: 1000, ttl: 5m }\nactor: gardener\n---\nDaily.\n');
  t.repo.write('jobs/refresh.md', '---\napplies-when:\n  - { on: external, name: refresh, effect: spawn }\nbudget: { tokens: 500, ttl: 2m }\nactor: gardener\n---\nRefresh.\n');
  t.repo.write('jobs/unbudgeted.md', '---\napplies-when:\n  - { on: external, name: refresh, effect: spawn }\nactor: gardener\n---\nNo budget.\n');
  t.repo.commit('jobs');
  t.accept();
}

test('jobs lists each job with its conditions, runs and problems', withInstallation(async (t) => {
  jobs(t);
  const listed = await t.run('jobs');
  assert.equal(listed.status, 'ok');
  assert.match(listed.text, /home:jobs\/daily\.md\n {2}on timer \(schedule "30 6 \* \* \*"\)\n {2}last run: never; pending: 0/);
  assert.match(listed.text, /home:jobs\/unbudgeted\.md\n {2}on external \(name refresh\)\n {2}problem: budget: is required on a document that can spawn work/);
}));

test('run claims a spawn for the job now, outside its conditions; something that is not a job is refused', withInstallation(async (t) => {
  jobs(t);
  const ran = await t.run('run', { document: 'jobs/daily.md' });
  assert.equal(ran.status, 'ok', ran.text);
  assert.match(ran.text, /Queued home:jobs\/daily\.md as trace [0-9A-Z]{26}; the daemon runs it\./);
  assert.deepEqual(listSpawns(t.context.state, { vault: 'home' }).map((s) => [s.document, s.state, s.event.kind]), [['jobs/daily.md', 'queued', 'manual']]);
  assert.equal((await t.run('run', { document: 'jobs/unbudgeted.md' })).status, 'refused');
  assert.equal((await t.run('run', { document: '_contract.md' })).status, 'refused');
  assert.match((await t.run('jobs')).text, /home:jobs\/daily\.md[^]*last run: queued[^]*pending: 1/);
}));

test('trigger queues every job whose external condition names the event, with its payload', withInstallation(async (t) => {
  jobs(t);
  const triggered = await t.run('trigger', { name: 'refresh', payload: '{"reason":"manual"}' });
  assert.equal(triggered.status, 'ok', triggered.text);
  const spawns = listSpawns(t.context.state, { vault: 'home' });
  assert.deepEqual(spawns.map((s) => s.document), ['jobs/refresh.md'], 'an unbudgeted job cannot spawn');
  assert.deepEqual(spawns[0]?.event, { kind: 'external', vault: 'home', name: 'refresh', payload: { reason: 'manual' }, id: (spawns[0]?.event as { id: string }).id });
  assert.equal((await t.run('trigger', { name: 'refresh', payload: 'not json' })).status, 'invalid', 'a malformed request, not a refusal');
  assert.match((await t.run('trigger', { name: 'nothing-listens' })).text, /Nothing matched/);
}));

test('run and trigger are refused for a vault with an unaccepted change; nothing is queued', withInstallation(async (t) => {
  jobs(t);
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  assert.equal((await t.run('run', { document: 'jobs/daily.md' })).status, 'refused');
  assert.match((await t.run('trigger', { name: 'refresh' })).text, /paused \(unaccepted change\)/);
  assert.deepEqual(listSpawns(t.context.state, { vault: 'home' }), []);
}));

test('script runs an approved script from the accepted main, in the vault, with only an interpreter\'s environment', posixOnly, withInstallation(async (t) => {
  t.repo.write('.vault/scripts/where.sh', scriptSource('where', 'echo "$1 in $(basename "$PWD")"; echo "token: ${SECRET_TOKEN:-none}"'));
  t.repo.commit('script');
  t.accept();
  const ran = await t.run('script', { name: 'where', args: ['hello'] });
  assert.equal(ran.status, 'ok', ran.text);
  assert.equal(ran.text, `hello in ${t.repo.path.split('/').at(-1)}\ntoken: none`);
  const failing = await t.run('script', { name: 'missing' });
  assert.equal(failing.status, 'failed');
}));

test('a session\'s scripts share the scratch directory it claimed as VAULT_SCRATCH; a lone run, or one with none claimed, has none', posixOnly, withInstallation(async (t) => {
  t.repo.write('.vault/scripts/scratch.sh', scriptSource('scratch', 'echo "scratch: ${VAULT_SCRATCH:-none}"; [ -z "$VAULT_SCRATCH" ] || ls -ld "$VAULT_SCRATCH" | cut -c1-10'));
  t.repo.commit('script');
  t.accept();
  const trace = '01JABCDEFGHJKMNPQRSTVWXYZ0';
  assert.equal((await t.run('script', { name: 'scratch' }, { caller: { session: 'a-session', trace } })).text, 'scratch: none', 'never made on the way');
  assert.ok(claimScratch(t.context.installation.paths, trace).ok);
  const inSession = await t.run('script', { name: 'scratch' }, { caller: { session: 'a-session', trace } });
  assert.equal(inSession.status, 'ok', inSession.text);
  assert.equal(inSession.text, `scratch: ${join(t.context.installation.paths.scratch, trace)}\ndrwx------`, 'private to the user');
  assert.equal((await t.run('script', { name: 'scratch' })).text, 'scratch: none');
}));

test('notify is a failure, not a crash, when notifications are not configured', withInstallation(async (t) => {
  const sent = await t.run('notify', { to: 'me', subject: 'x', body: 'y' });
  assert.equal(sent.status, 'failed');
  assert.match(sent.text, /notify is not configured/);
}));

test('notify refuses an address or an unknown alias', withInstallation(async (t) => {
  assert.equal((await t.run('notify', { to: 'me@example.net', subject: 'x', body: 'y' })).status, 'refused');
  assert.equal((await t.run('notify', { to: 'nobody', subject: 'x', body: 'y' })).status, 'refused');
}, { config: 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { me: me@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }' }));

test('trace shows the compact record from the note on the run\'s latest commit; an unknown trace is not found', withInstallation(async (t) => {
  const trace = '01JABCDEFGHJKMNPQRSTVWXYZ0';
  const noted = (documents: string[]) => renderCompactTrace({
    trace, vault: 'home', path: [], trigger: { event: 'manual', document: 'jobs/daily.md' },
    sessions: [{ actor: 'gardener', started: '2026-01-01T00:00:00.000Z', tokens: 120, outcome: 'committed' }],
    judgements: [], scripts: [], documents, elsewhere: [],
  });
  t.repo.write('digests/yesterday.md', 'x');
  const first = t.repo.commit(`Yesterday\n\nVault-Trace: ${trace}`);
  t.repo.git('notes', `--ref=${TRACES_REF}`, 'add', '-m', noted(['digests/yesterday.md']), first);
  t.repo.write('digests/today.md', 'x');
  const last = t.repo.commit(`Today\n\nVault-Trace: ${trace}`);
  t.repo.git('notes', `--ref=${TRACES_REF}`, 'add', '-m', noted(['digests/today.md', 'digests/yesterday.md']), last);
  t.accept();
  const shown = await t.run('trace', { id: trace });
  assert.equal(shown.status, 'ok', shown.text);
  assert.match(shown.text, /home: manual jobs\/daily\.md[^]*session gardener: committed, 120 tokens\n  produced digests\/today\.md\n  produced digests\/yesterday\.md\n  commits: [0-9a-f]{12}, [0-9a-f]{12}/);
  assert.equal((shown.data as { records: unknown[] }).records.length, 1, 'one record per vault: the latest');
  assert.equal((await t.run('trace', { id: '01JABCDEFGHJKMNPQRSTVWXYZ1' })).status, 'failed');
  assert.equal((await t.run('trace', { id: 'not-a-trace' })).status, 'invalid');
}));

test('a job with no actor is listed with the problem, and neither runs nor is triggered', withInstallation(async (t) => {
  t.repo.write('jobs/actorless.md', '---\napplies-when:\n  - { on: external, name: bell, effect: spawn }\nbudget: { tokens: 500, ttl: 2m }\n---\nNo actor.\n');
  t.repo.commit('job');
  t.accept();
  assert.match((await t.run('jobs')).text, /home:jobs\/actorless\.md\n {2}on external \(name bell\)\n {2}problem: actor: is required on a document that can spawn work/);
  const ran = await t.run('run', { document: 'jobs/actorless.md' });
  assert.equal(ran.status, 'refused');
  assert.match(ran.text, /actor: is required/);
  assert.match((await t.run('trigger', { name: 'bell' })).text, /Nothing matched/);
  assert.deepEqual(listSpawns(t.context.state, { vault: 'home' }), []);
}));

// concepts.md "Models": a job that cannot run for lack of a model is shown, not hidden — `jobs` says which model each uses.
const JOB_ON = (model: string): string => `---\napplies-when:\n  - { on: external, name: go, effect: spawn }\nbudget: { tokens: 500, ttl: 2m }\nactor: gardener\n${model}---\nGo.\n`;
const QUICK = { noDefaultModels: true, config: 'models:\n  agent: { model: p/big }\n  quick: { role: agent, model: p/small }\n  judge: { role: judgement, url: "https://x.example.net/v1", token: "${T}", model: j }\npolicy:\n  - { vaults: [home], allow-models: [agent, judge] }' };

test('jobs says which model a job asks for, and which cannot run for lack of one', withInstallation(async (t) => {
  t.repo.write('jobs/plain.md', JOB_ON(''));
  t.repo.write('jobs/unknown.md', JOB_ON('model: telepathy\n'));
  t.repo.write('jobs/quick.md', JOB_ON('model: quick\n'));
  t.repo.write('jobs/judge.md', JOB_ON('model: judge\n'));
  t.repo.commit('jobs');
  t.accept();
  const listed = await t.run('jobs');
  assert.equal(listed.status, 'ok');
  assert.match(listed.text, /home:jobs\/plain\.md\n {2}on external \(name go\)\n {2}last run/, 'the default is not mentioned');
  assert.match(listed.text, /home:jobs\/quick\.md\n/);
  assert.match(listed.text, /home:jobs\/unknown\.md\n[^]*? {2}model: agent \(asked for "telepathy", which is not configured\)\n/);
  assert.match(listed.text, /home:jobs\/quick\.md\n[^]*? {2}problem: no agent model it may use \(the policy does not allow "quick" for home\)\n/);
  assert.match(listed.text, /home:jobs\/judge\.md\n[^]*? {2}problem: no agent model it may use \("judge" is a judgement model\)\n/);
  const data = (listed.data as { jobs: { document: string; model?: { name: string } }[] }).jobs;
  assert.deepEqual(data.map((j) => [j.document, j.model?.name]), [['jobs/judge.md', undefined], ['jobs/plain.md', 'agent'], ['jobs/quick.md', undefined], ['jobs/unknown.md', 'agent']]);
}, QUICK));

test('with no agent model at all, jobs say so and the rest of the vault still answers', withInstallation(async (t) => {
  t.repo.write('jobs/plain.md', JOB_ON(''));
  t.repo.commit('jobs');
  t.accept();
  const listed = await t.run('jobs');
  assert.match(listed.text, /problem: no agent model it may use \(the default agent model is not configured\)/);
  assert.equal((await t.run('status')).status, 'ok');
}, { noDefaultModels: true }));
