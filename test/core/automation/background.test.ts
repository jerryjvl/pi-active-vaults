// Documented behaviour: daemon.md — "Forge sync": for `forge`-mode vaults the
// daemon fetches to detect merges (the forge's main becomes the accepted
// main), and for the vaults it runs pushes actor branches and keeps pull
// requests, commit statuses and `vault/policy` current; when it learns that a
// proposal was merged, it checks that the proposal's head is in the new main
// and reports one that is not (security-setup.md); "Outbox": it retries
// undelivered notifications with backoff (notifications.md "Nothing is lost
// on failure"). Against a local bare repository behind the forge's URL, a
// stub forge API and a sendmail command that can be made to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Automation } from '../../../src/core/automation/index.ts';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import { sendNotification, undeliveredNotifications } from '../../../src/core/notify/index.ts';
import { notifyDeps, scriptEnvironment } from '../../../src/core/operations/index.ts';
import { automationFor, fakePi } from '../../support/daemon.ts';
import { mergeInForge, mergePullInForge, withForgeInstallation } from '../../support/forge-vault.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'a POSIX shell as sendmail' : false };
const MINUTE = 60_000;

async function commitAsGardener(t: TestInstallation, path: string, content: string): Promise<string> {
  assert.equal((await t.run('write', { path, content, actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
  assert.equal((await t.run('commit', { message: `Write ${path}`, actor: 'gardener' })).status, 'ok');
  return t.repo.git('rev-parse', 'refs/heads/actor/gardener');
}

async function forgeStatus(automation: Automation): Promise<{ vault: string; error?: string; proposed?: string[] }[]> {
  const reply = await automation.handle({ id: 's', method: 'status', params: {} }, () => {});
  return ((reply as { result: { forge: { vault: string; error?: string; proposed?: string[] }[] } }).result.forge);
}

test('each tick fetches a forge vault: a merge in the forge becomes the accepted main, and main follows it', withForgeInstallation(async (t, forge) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  const merged = mergeInForge(forge, { 'notes/merged.md': 'merged in the forge\n' });
  await automation.tick();
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
  assert.equal(t.repo.git('rev-parse', 'main'), merged);
}));

test('a hosted forge vault\'s actor branches are proposed when their head moves, and their statuses refreshed every few minutes', withForgeInstallation(async (t, forge) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  const first = await commitAsGardener(t, 'notes/a.md', '# A\n');
  await automation.tick();
  assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), first);
  assert.deepEqual(forge.stub.model.pulls.map((p) => p.head), ['actor/gardener']);
  const published = forge.stub.model.statuses.length;
  assert.ok(published > 0);
  assert.deepEqual((await forgeStatus(automation)).map((f) => [f.vault, f.error, f.proposed]), [['home', undefined, ['gardener']]]);

  await automation.tick();
  assert.equal(forge.stub.model.statuses.length, published, 'nothing new: nothing republished within minutes');
  t.clock.advance(5 * MINUTE);
  await automation.tick();
  assert.ok(forge.stub.model.statuses.length > published, 'refreshed, to pick up reviews in the forge');

  const second = await commitAsGardener(t, 'notes/b.md', '# B\n');
  await automation.tick();
  assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), second);
  assert.equal(forge.stub.model.pulls.length, 1, 'the same pull request, updated');
  assert.equal(forge.remote('rev-parse', 'refs/heads/main'), t.repo.git('rev-parse', 'refs/remotes/origin/main'), 'main is never pushed');
}, { host: true }));

test('a forge vault this installation does not run is fetched, but nothing is pushed from here', withForgeInstallation(async (t, forge) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  await commitAsGardener(t, 'notes/a.md', '# A\n');
  const merged = mergeInForge(forge, { 'notes/merged.md': 'x\n' });
  await automation.tick();
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
  assert.equal(forge.remote('branch', '--list', 'actor/gardener'), '');
  assert.deepEqual(forge.stub.model.pulls, []);
}));

test('a sync that fails is in the daemon\'s status, and tried again on the next tick', withForgeInstallation(async (t) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  await automation.tick();
  assert.deepEqual((await forgeStatus(automation)).map((f) => [f.vault, f.error]), [['home', 'no-forge']]);
}, { host: true, forges: false }));

const NOTIFY = 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { alice: alice@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }';

for (const how of ['squash', 'rebase'] as const) {
  test(`a proposal merged by ${how} is reported in status and doctor and told to the owners once; one merged with its commits is not`, withForgeInstallation(async (t, forge) => {
    const automation = automationFor(t, fakePi(t));
    await automation.start();
    const outbox = () => t.context.state.all<{ alias: string; subject: string; body: string }>('SELECT alias, subject, body FROM notify_outbox');
    const lostIn = async (operation: 'status' | 'doctor') => {
      const outcome = await t.run(operation, {});
      return operation === 'status'
        ? outcome.text.split('\n').filter((l) => /no longer attach/.test(l))
        : (outcome.data as { findings: { check: string; level: string; message: string }[] }).findings.filter((f) => f.check === 'merges').map((f) => `${f.level}: ${f.message}`);
    };

    await commitAsGardener(t, 'notes/a.md', '# A\n');
    await automation.tick();
    mergePullInForge(forge, 1, 'merge');
    await automation.tick();
    assert.deepEqual(outbox(), [], 'a merge commit keeps the proposal\'s commits');
    assert.deepEqual(await lostIn('status'), []);
    assert.deepEqual(await lostIn('doctor'), []);

    const head = await commitAsGardener(t, 'notes/b.md', '# B\n');
    await automation.tick();
    assert.deepEqual(forge.stub.model.pulls.map((p) => [p.number, p.state]), [[1, 'merged'], [2, 'open']]);
    const main = mergePullInForge(forge, 2, how);
    await automation.tick();
    assert.equal(acceptedMain(t.context.state, 'home')?.sha, main, 'the merge is still learnt of');

    const status = await lostIn('status');
    assert.equal(status.length, 1);
    assert.match(status[0] ?? '', new RegExp(`#2 from gardener .*head ${head} is not in main`));
    const doctor = await lostIn('doctor');
    assert.equal(doctor.length, 1);
    assert.match(doctor[0] ?? '', /^warning: .*#2 from gardener/);
    const told = outbox();
    assert.deepEqual(told.map((m) => m.alias), ['alice'], 'the owner, once');
    assert.match(told[0]?.subject ?? '', /home/);
    assert.match(told[0]?.body ?? '', /#2 .*actor\/gardener[\s\S]*attestations and trace notes no longer attach/);

    await automation.tick();
    t.clock.advance(10 * MINUTE);
    await automation.tick();
    assert.equal(outbox().length, 1, 'told once, not every tick');
  }, { host: true, config: NOTIFY }));
}

test('what merged is asked before fetching, so a merge made in between is judged against a main that holds it', withForgeInstallation(async (t, forge) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  await commitAsGardener(t, 'notes/a.md', '# A\n');
  await automation.tick();
  let merged: string | undefined;
  forge.stub.model.onList = (query) => {
    if (query.get('state') === 'closed' && merged === undefined) merged = mergePullInForge(forge, 1, 'merge');
  };
  await automation.tick();
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
  assert.deepEqual(t.context.state.all('SELECT * FROM notify_outbox'), []);
  assert.ok(!(await t.run('status', {})).text.includes('no longer attach'), 'fetching first would have judged it against a main without the merge');
}, { host: true, config: NOTIFY }));

test('each tick retries the outbox\'s messages that are due, with backoff, until they are delivered', posixOnly, async () => {
  const box = mkdtempSync(join(tmpdir(), 'pav-sendmail-'));
  const failing = join(box, 'fail');
  const sent = join(box, 'sent');
  const script = `cat >/dev/null; test -e '${failing}' && exit 1; echo sent >> '${sent}'`;
  try {
    writeFileSync(failing, '');
    await withInstallation(async (t) => {
      const automation = automationFor(t, fakePi(t));
      await automation.start();
      const deps = notifyDeps(t.context, scriptEnvironment(t.installation));
      assert.ok(deps !== undefined);
      const first = await sendNotification(deps, { to: 'me', subject: 'Hello', body: 'Hi.\n', trace: '01JABCDEFGHJKMNPQRSTVWXYZ0' });
      assert.equal(first.ok && first.value.outcome, 'queued');
      unlinkSync(failing);
      t.clock.advance(30_000);
      await automation.tick();
      assert.equal(existsSync(sent), false, 'not yet due: the first retry waits a minute');
      t.clock.advance(31_000);
      await automation.tick();
      assert.equal(readFileSync(sent, 'utf8'), 'sent\n');
      assert.deepEqual(undeliveredNotifications(t.context.state), []);
      await automation.tick();
      assert.equal(readFileSync(sent, 'utf8'), 'sent\n', 'delivered once');
    }, {
      config: `notify:\n  from: "Vault <vault@example.net>"\n  recipients: { me: me@example.net }\n  transport: { type: sendmail, command: /bin/sh, args: ["-c", ${JSON.stringify(script)}] }`,
    })();
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
