// Documented behaviour: daemon.md — "Forge sync": for `forge`-mode vaults the
// daemon fetches to detect merges (the forge's main becomes the accepted
// main), and for the vaults it runs pushes actor branches and keeps pull
// requests, commit statuses and `vault/policy` current; when it learns that a
// proposal was merged, it checks that the proposal's head is in the new main
// and reports one that is not (security-setup.md), resetting its actor branch
// to main when that loses nothing and leaving it, with what to do, when not;
// "Outbox": it retries undelivered notifications with backoff (notifications.md
// "Nothing is lost on failure"). Against a local bare repository behind the
// forge's URL, a stub forge API and a sendmail command that can be made to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseActorHold, takeActorHold } from '../../../src/core/actors/index.ts';
import type { Automation } from '../../../src/core/automation/index.ts';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import { sendNotification, undeliveredNotifications } from '../../../src/core/notify/index.ts';
import { notifyDeps, scriptEnvironment } from '../../../src/core/operations/index.ts';
import { automationFor, fakePi } from '../../support/daemon.ts';
import { startStubServer } from '../../support/stub-server.ts';
import { RETRY_MS } from '../../../src/core/automation/indexing.ts';
import { mergeInForge, mergePullInForge, withForgeInstallation, type Forge } from '../../support/forge-vault.ts';
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
  assert.equal(forge.stub.model.statuses.length, published, 'checked again, but nothing changed: nothing republished');
  forge.stub.model.reviews.push({ pull: 1, user: 'alice', state: 'APPROVED', commit: first });
  t.clock.advance(5 * MINUTE);
  await automation.tick();
  const policy = forge.stub.model.statuses.filter((s) => s.context === 'vault/policy');
  assert.equal(policy.at(-1)?.state, 'success', 'refreshed: a review in the forge is picked up and published');
  assert.ok(forge.stub.model.statuses.length > published);
  assert.deepEqual(forge.stub.model.scheduledMerges.map((m) => [m.pull, m.head, m.style]), [[1, first, 'merge']], 'the forge was asked to merge it at that head, with a merge commit');

  const second = await commitAsGardener(t, 'notes/b.md', '# B\n');
  await automation.tick();
  assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), second);
  assert.equal(forge.stub.model.pulls.length, 1, 'the same pull request, updated');
  assert.equal(forge.remote('rev-parse', 'refs/heads/main'), t.repo.git('rev-parse', 'refs/remotes/origin/main'), 'main is never pushed');
}, { host: true }));

test('the person\'s own proposal is never pushed from here, but once proposed its statuses are kept current in a vault run elsewhere, every minute while it waits only on an owner', withForgeInstallation(async (t, forge) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  const policyOf = (sha: string) => forge.stub.model.statuses.filter((s) => s.sha === sha && s.context === 'vault/policy').at(-1)?.state;
  const commitAsAlice = async (path: string): Promise<string> => {
    assert.equal((await t.run('write', { path, content: `# ${path}\n` })).status, 'ok');
    assert.equal((await t.run('commit', { message: `Write ${path}` })).status, 'ok');
    return t.repo.git('rev-parse', 'refs/heads/actor/alice');
  };

  const head = await commitAsAlice('notes/a.md');
  await automation.tick();
  assert.equal(forge.remote('branch', '--list', 'actor/alice'), '', 'not proposed: nothing is pushed');
  assert.deepEqual(forge.stub.model.statuses, []);

  const proposed = await t.run('propose', { actor: 'alice' });
  assert.equal(proposed.status, 'ok', proposed.text);
  assert.equal(policyOf(head), 'pending');
  await automation.tick();
  const published = forge.stub.model.statuses.length;
  await automation.tick();
  assert.equal(forge.stub.model.statuses.length, published, 'nothing republished within the minute');

  forge.stub.model.reviews.push({ pull: 1, user: 'alice', state: 'APPROVED', commit: head });
  t.clock.advance(MINUTE);
  await automation.tick();
  assert.equal(policyOf(head), 'success', 'an approval in the forge is picked up within a minute');
  assert.deepEqual((await forgeStatus(automation)).map((f) => [f.vault, f.error, f.proposed]), [['home', undefined, ['alice']]]);
  const satisfied = forge.stub.model.statuses.length;
  t.clock.advance(MINUTE);
  await automation.tick();
  assert.equal(forge.stub.model.statuses.length, satisfied, 'no longer waiting on an owner: back to every few minutes');

  const later = await commitAsAlice('notes/b.md');
  t.clock.advance(5 * MINUTE);
  await automation.tick();
  assert.equal(forge.remote('rev-parse', 'refs/heads/actor/alice'), head, 'new work is theirs to propose');
  assert.equal(policyOf(later), undefined, 'and no statuses land on a commit the forge was not given');
}));

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

const BRANCH = 'refs/heads/actor/gardener';
const SESSION = { vault: 'home', actor: 'gardener', holder: { process: { pid: 7, started: 's' }, session: 'S' } };

/** What `status` and `doctor` say of merges that lost their commits. */
async function lostIn(t: TestInstallation, operation: 'status' | 'doctor'): Promise<string[]> {
  const outcome = await t.run(operation, {});
  return operation === 'status'
    ? outcome.text.split('\n').filter((l) => /no longer attach/.test(l))
    : (outcome.data as { findings: { check: string; level: string; message: string }[] }).findings.filter((f) => f.check === 'merges').map((f) => `${f.level}: ${f.message}`);
}

const outboxOf = (t: TestInstallation) => t.context.state.all<{ alias: string; subject: string; body: string }>('SELECT alias, subject, body FROM notify_outbox');
const pullsOf = (forge: Forge) => forge.stub.model.pulls.map((p) => [p.number, p.state]);

/**
 * A first proposal merged with a merge commit (nothing lost), then a second
 * merged as `how`, with `between` run after the second was proposed and before
 * it merged. Returns the second's head and the main after its merge.
 */
async function loseMerge(
  t: TestInstallation, forge: Forge, automation: Automation, how: 'squash' | 'rebase', between: () => Promise<void> = async () => {},
): Promise<{ head: string; main: string }> {
  await commitAsGardener(t, 'notes/a.md', '# A\n');
  await automation.tick();
  mergePullInForge(forge, 1, 'merge');
  await automation.tick();
  assert.deepEqual(outboxOf(t), [], 'a merge commit keeps the proposal\'s commits');
  assert.deepEqual(await lostIn(t, 'status'), []);
  assert.deepEqual(await lostIn(t, 'doctor'), []);

  const head = await commitAsGardener(t, 'notes/b.md', '# B\n');
  await automation.tick();
  assert.deepEqual(pullsOf(forge), [[1, 'merged'], [2, 'open']]);
  await between();
  const main = mergePullInForge(forge, 2, how);
  await automation.tick();
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, main, 'the merge is still learnt of');
  return { head, main };
}

/** A daemon started again: it remembers nothing of what the last one proposed. */
async function restart(t: TestInstallation): Promise<Automation> {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  return automation;
}

for (const how of ['squash', 'rebase'] as const) {
  test(`a proposal merged by ${how} is told to the owners once and its branch reset to main; one merged with its commits is not touched`, withForgeInstallation(async (t, forge) => {
    const automation = automationFor(t, fakePi(t));
    await automation.start();
    const { main } = await loseMerge(t, forge, automation, how);

    assert.equal(t.repo.git('rev-parse', BRANCH), main, 'nothing held the actor and its worktree was clean');
    assert.equal(t.repo.git('-C', join(t.vault.worktrees, 'gardener'), 'rev-parse', 'HEAD'), main);
    assert.deepEqual(await lostIn(t, 'status'), [], 'the report clears itself: the branch no longer holds the head');
    assert.deepEqual(await lostIn(t, 'doctor'), []);
    const told = outboxOf(t);
    assert.deepEqual(told.map((m) => m.alias), ['alice'], 'the owner, once');
    assert.match(told[0]?.subject ?? '', /home/);
    assert.match(told[0]?.body ?? '', /#2 .*actor\/gardener[\s\S]*attestations and trace notes no longer attach[\s\S]*reset to main/);

    t.clock.advance(10 * MINUTE);
    await automation.tick();
    await (await restart(t)).tick();
    assert.equal(outboxOf(t).length, 1, 'told once, not again after more ticks or a restart');
    assert.deepEqual(pullsOf(forge), [[1, 'merged'], [2, 'merged']], 'no pull request is opened for it');
  }, { host: true, config: NOTIFY }));
}

const OBSTACLES: readonly { name: string; before: (t: TestInstallation) => Promise<void>; why: RegExp; after?: (t: TestInstallation) => Promise<void> }[] = [
  {
    name: 'a session holds the actor',
    before: async (t) => { assert.ok((await takeActorHold(t.context.state, t.context.alive, t.clock, SESSION)).ok); },
    why: /session S holds gardener/,
    after: async (t) => { assert.ok(releaseActorHold(t.context.state, SESSION)); },
  },
  {
    name: 'the branch has moved on from the approved head',
    before: async (t) => { await commitAsGardener(t, 'notes/c.md', '# C\n'); },
    why: /moved on from the approved head/,
  },
  {
    name: 'the branch has moved on from the approved head and has no worktree',
    before: async (t) => {
      await commitAsGardener(t, 'notes/c.md', '# C\n');
      t.repo.git('worktree', 'remove', join(t.vault.worktrees, 'gardener'));
    },
    why: /moved on from the approved head/,
  },
  {
    name: 'its worktree has a tracked change',
    before: async (t) => { writeFileSync(join(t.vault.worktrees, 'gardener', 'notes', 'b.md'), 'edited'); },
    why: /uncommitted changes/,
  },
  {
    name: 'its worktree has an untracked file',
    before: async (t) => { writeFileSync(join(t.vault.worktrees, 'gardener', 'scratch.md'), 'draft'); },
    why: /uncommitted changes/,
  },
];

for (const { name, before, why, after } of OBSTACLES) {
  test(`a merged proposal's branch is left as it is when ${name}: reported with what to do, no pull request opened again, and the report clears when the branch is reset`, withForgeInstallation(async (t, forge) => {
    const automation = automationFor(t, fakePi(t));
    await automation.start();
    const { head } = await loseMerge(t, forge, automation, 'squash', () => before(t));
    const tip = t.repo.git('rev-parse', BRANCH);
    assert.ok(tip === head || t.repo.git('merge-base', '--is-ancestor', head, tip) === '', 'the branch still holds the approved head');

    const status = await lostIn(t, 'status');
    assert.equal(status.length, 1);
    assert.match(status[0] ?? '', new RegExp(`#2 from gardener .*head ${head} is not in main`));
    assert.match(status[0] ?? '', /reset actor\/gardener to main/, 'what to do');
    const command = /`(git [^`]+)`/.exec(status[0] ?? '')?.[1];
    assert.ok(command !== undefined, 'the exact command');
    assert.match(status[0] ?? '', /discards/, 'and what it costs');
    assert.equal(command.includes(join(t.vault.worktrees, 'gardener')), t.repo.git('worktree', 'list').includes(join(t.vault.worktrees, 'gardener')), 'it names the worktree where the branch has one, the vault where not');
    assert.equal((await lostIn(t, 'doctor')).length, 1);
    const told = outboxOf(t);
    assert.equal(told.length, 1);
    assert.match(told[0]?.body ?? '', why);
    assert.ok((told[0]?.body ?? '').includes(command), 'the notice gives the same command');

    t.clock.advance(10 * MINUTE);
    await automation.tick();
    const restarted = await restart(t);
    await restarted.tick();
    assert.equal(outboxOf(t).length, 1, 'neither a later tick nor a restart reports it again');
    assert.deepEqual(pullsOf(forge), [[1, 'merged'], [2, 'merged']], 'neither a later tick nor a restart opens a pull request for it');
    assert.equal(t.repo.git('rev-parse', BRANCH), tip, 'and the branch stays as it was');
    assert.equal((await lostIn(t, 'status')).length, 1, 'while the branch holds the head, it is listed');

    // The owner follows the report; it clears itself.
    await after?.(t);
    execFileSync('sh', ['-c', command], { env: t.repo.env });
    assert.deepEqual(await lostIn(t, 'status'), []);
    assert.deepEqual(await lostIn(t, 'doctor'), []);
    await restarted.tick();
    assert.equal(outboxOf(t).length, 1);
    assert.deepEqual(pullsOf(forge), [[1, 'merged'], [2, 'merged']]);

    // New work is proposed like any other: the forge still holds the branch at the head it
    // reported merged, which the push replaces.
    await commitAsGardener(t, 'notes/d.md', '# D\n');
    await restarted.tick();
    assert.deepEqual(pullsOf(forge), [[1, 'merged'], [2, 'merged'], [3, 'open']]);
  }, { host: true, config: NOTIFY, running: { 7: 's' } }));
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

test('each tick reads the notification spools: a message left there is mailed to the spool\'s alias and removed', posixOnly, async () => {
  const box = mkdtempSync(join(tmpdir(), 'pav-spool-'));
  const spool = join(box, 'spool');
  const sent = join(box, 'sent');
  const script = `cat >> '${sent}'`;
  try {
    mkdirSync(spool, { mode: 0o2730 });
    await withInstallation(async (t) => {
      const automation = automationFor(t, fakePi(t));
      await automation.start();
      writeFileSync(join(spool, '.tmp-1'), 'Subject: Blocked fetch\n\nA card number was refused.\n');
      renameSync(join(spool, '.tmp-1'), join(spool, 'alert-1'));
      await automation.tick();
      assert.match(readFileSync(sent, 'utf8'), /To: me@example\.net[\s\S]*A card number was refused\./);
      assert.deepEqual(readdirSync(spool), []);
      const reply = await automation.handle({ id: 's', method: 'status', params: {} }, () => {});
      const spools = (reply as { result: { spools: { alias: string; sentLastHour: number }[] } }).result.spools;
      assert.deepEqual(spools.map((s) => [s.alias, s.sentLastHour]), [['me', 1]]);
    }, {
      config: `notify:\n  from: "Vault <vault@example.net>"\n  recipients: { me: me@example.net }\n  transport: { type: sendmail, command: /bin/sh, args: ["-c", ${JSON.stringify(script)}] }\n  spools: { me: ${JSON.stringify(spool)} }`,
    })();
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test('a merge the forge refused to schedule is in the daemon\'s status, and asked for again until it is accepted', withForgeInstallation(async (t, forge) => {
  forge.stub.model.mergeForbidden = true;
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  const head = await commitAsGardener(t, 'notes/a.md', '# A\n');
  await automation.tick();
  assert.match((await forgeStatus(automation))[0]?.error ?? '', /gardener: the forge will not merge it itself \(this account may not merge/);
  const scheduled = () => forge.stub.model.scheduledMerges.map((m) => m.head);
  assert.equal(scheduled().length, 0);
  forge.stub.model.mergeForbidden = false;
  t.clock.advance(5 * MINUTE);
  await automation.tick();
  assert.deepEqual(scheduled(), [head], 'the allowlist fixed: scheduled without a new proposal');
  assert.equal((await forgeStatus(automation))[0]?.error, undefined);
}, { host: true }));

async function indexStatus(automation: Automation): Promise<{ vault: string; at: string; sha?: string; added?: number; changed?: number; removed?: number; error?: string }[]> {
  const reply = await automation.handle({ id: 's', method: 'status', params: {} }, () => {});
  return (reply as { result: { indexing: { vault: string; at: string; sha?: string; added?: number; changed?: number; removed?: number; error?: string }[] } }).result.indexing;
}

test('each tick brings the search index up to an accepted main that moved, in the background; an unaccepted commit is never indexed', withInstallation(async (t) => {
  t.repo.write('notes/router.md', '# Router\nThe router lives in the hall cupboard.\n');
  t.repo.commit('router');
  t.accept();
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  await automation.idle();
  assert.match((await t.run('search', { query: 'cupboard router' })).text, /^home:notes\/router\.md/, 'a vault never indexed is brought in');
  const first = (await indexStatus(automation)).find((s) => s.vault === 'home');
  assert.equal(first?.sha, t.repo.git('rev-parse', 'main'));

  t.repo.write('notes/kettle.md', '# Kettle\nThe kettle descales monthly.\n');
  t.repo.commit('kettle');
  await automation.tick();
  await automation.idle();
  assert.ok((await t.run('search', { query: 'kettle descales' })).text.startsWith('No hits.'), 'not accepted yet: not searchable');

  const accepted = t.accept();
  await automation.tick();
  await automation.idle();
  assert.match((await t.run('search', { query: 'kettle descales' })).text, /^home:notes\/kettle\.md/, 'accepted: searchable after the next tick');
  const second = (await indexStatus(automation)).find((s) => s.vault === 'home');
  assert.deepEqual({ sha: second?.sha, added: second?.added, changed: second?.changed, removed: second?.removed }, { sha: accepted.sha, added: 1, changed: 0, removed: 0 });

  await automation.tick();
  await automation.idle();
  assert.equal((await indexStatus(automation)).find((s) => s.vault === 'home')?.at, second?.at, 'an index already at the accepted main is left alone');
}));

test('a merge fetched from the forge is indexed on the same tick that makes it the accepted main', withForgeInstallation(async (t, forge) => {
  const automation = automationFor(t, fakePi(t));
  await automation.start();
  await automation.idle();
  const merged = mergeInForge(forge, { 'notes/merged.md': '# Merged\nThe heat pump filter was replaced.\n' });
  await automation.tick();
  await automation.idle();
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
  assert.match((await t.run('search', { query: 'heat pump filter' })).text, /^home:notes\/merged\.md/);
}));

test('vectors that failed are tried again after a pause, not every minute; keyword search works meanwhile', async () => {
  let failing = true;
  const embed = await startStubServer((request) => {
    if (failing) return { status: 503, body: { error: 'down' } };
    const input = (JSON.parse(request.body) as { input: string[] }).input;
    return { body: { data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) } };
  });
  try {
    await withInstallation(async (t) => {
      t.repo.write('notes/router.md', '# Router\nThe router lives in the hall cupboard.\n');
      t.repo.commit('router');
      t.accept();
      const automation = automationFor(t, fakePi(t));
      await automation.start();
      await automation.idle();
      const first = (await indexStatus(automation)).find((s) => s.vault === 'home');
      assert.match(first?.error ?? '', /^vectors: /, 'the embedding model was down');
      assert.match((await t.run('search', { query: 'cupboard router' })).text, /^home:notes\/router\.md/, 'keyword search meanwhile');
      const asked = embed.requests.length;
      failing = false;
      t.clock.advance(MINUTE);
      await automation.tick();
      await automation.idle();
      assert.equal(embed.requests.length, asked, 'not retried a minute later');
      t.clock.advance(RETRY_MS);
      await automation.tick();
      await automation.idle();
      assert.ok(embed.requests.length > asked, 'retried after the pause');
      assert.equal((await indexStatus(automation)).find((s) => s.vault === 'home')?.error, undefined);
    }, {
      noDefaultModels: true,
      config: `models:\n  agent: { model: faux/faux-1 }\n  embed: { url: "${embed.url}/v1", model: embed-model, token: "!echo t" }\npolicy:\n  - { vaults: [home], allow-models: [agent, embed] }`,
    })();
  } finally {
    await embed.close();
  }
});
