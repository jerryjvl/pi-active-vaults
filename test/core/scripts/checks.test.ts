// Documented behaviour: concepts.md "Script" — checks are scripts in
// `.vault/checks/` that assess a proposal and produce an attestation; the
// `checks` requirement needs every check on the accepted `main` to have passed
// for the exact commit, at that check's version. security.md — checks run only
// from the accepted `main`, and not at all while `main` has an unaccepted
// change. principles.md 9 — a check that cannot reach a verdict never passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttestations } from '../../../src/core/attestations/index.ts';
import { checkStatuses } from '../../../src/core/policy/index.ts';
import { listScripts, recordCheckResults, runChecks, type CheckRunOptions } from '../../../src/core/scripts/index.ts';
import { TEST_ATTRIBUTION } from '../../support/git-repo.ts';
import { scriptSource as script, withTestVault, type TestVault } from '../../support/vault.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };

function options(overrides: Partial<CheckRunOptions> = {}): CheckRunOptions {
  return {
    env: { PATH: process.env['PATH'] ?? '' },
    timeoutMs: 10_000,
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    sandbox: 'none',
    ...overrides,
  };
}

const context = (v: TestVault) => ({ git: v.git, store: v.store, vault: v.vault });

test('each check on the accepted main assesses the exact commit: its files as committed, the proposal on standard input', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/checks/has-title.sh', script('has-title', 'grep -q "^# " notes/a.md && echo "title found" || { echo "no title in notes/a.md"; exit 1; }'));
  v.repo.write('.vault/checks/proposal.sh', script('proposal', 'cat'));
  v.repo.commit('checks');
  const accepted = v.accept();
  const head = v.propose({ 'notes/a.md': '# A note\n' });

  const ran = await runChecks(context(v), { commit: head, actor: 'gardener' }, options());
  assert.ok(ran.ok, JSON.stringify(ran));
  const [hasTitle, proposal] = ran.value.results;
  assert.deepEqual([hasTitle?.name, hasTitle?.result, hasTitle?.evidence], ['has-title', 'pass', 'title found']);
  assert.equal(proposal?.result, 'pass');
  assert.deepEqual(JSON.parse(proposal?.evidence ?? ''), {
    actor: 'gardener', base: accepted.sha, changes: [{ change: 'created', path: 'notes/a.md' }], commit: head, vault: 'home',
  });
  assert.equal(ran.value.passed, true);

  const untitled = v.propose({ 'notes/a.md': 'no heading\n' });
  const failed = await runChecks(context(v), { commit: untitled, actor: 'gardener' }, options());
  assert.ok(failed.ok);
  assert.deepEqual(failed.value.results.map((r) => [r.name, r.result, r.evidence]).slice(0, 1), [['has-title', 'fail', 'no title in notes/a.md']]);
  assert.equal(failed.value.passed, false);
}));

test('only the accepted main\'s checks run: a check added or changed on a branch runs at its accepted version, or not at all', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/checks/strict.sh', script('strict', 'exit 1'));
  v.repo.commit('a strict check');
  v.accept();
  const head = v.propose({ '.vault/checks/strict.sh': script('strict', 'exit 0'), '.vault/checks/lenient.sh': script('lenient', 'exit 0') });
  const ran = await runChecks(context(v), { commit: head, actor: 'gardener' }, options());
  assert.ok(ran.ok);
  assert.deepEqual(ran.value.results.map((r) => [r.name, r.result]), [['strict', 'fail']]);
}));

test('checks are refused while main has an unaccepted change, and nothing runs', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/checks/marker.sh', script('marker', `touch "${v.repo.path}/ran"; exit 0`));
  v.repo.commit('check');
  v.accept();
  const head = v.propose({ 'a.md': 'a' });
  v.repo.write('stray.md', 'x');
  v.repo.commit('stray commit on main');
  const ran = await runChecks(context(v), { commit: head, actor: 'gardener' }, options());
  assert.equal(!ran.ok && ran.error.reason, 'unaccepted-change');
  assert.equal(v.repo.git('status', '--porcelain', '--untracked-files=all').includes('ran'), false);
}));

test('a check that cannot reach a verdict — timed out, unable to run, or invalid — is an error, never a pass', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/checks/slow.sh', script('slow', 'sleep 5'));
  v.repo.write('.vault/checks/missing-interpreter.sh', script('missing-interpreter', 'exit 0', { interpreter: '/nonexistent/interpreter' }));
  v.repo.write('.vault/checks/broken.sh', '#!/bin/sh\n# name: broken\nexit 0\n');
  v.repo.commit('checks');
  v.accept();
  const head = v.propose({ 'a.md': 'a' });
  const ran = await runChecks(context(v), { commit: head, actor: 'gardener' }, options({ timeoutMs: 200 }));
  assert.ok(ran.ok);
  assert.deepEqual(ran.value.results.map((r) => [r.name, r.result]), [['broken', 'error'], ['missing-interpreter', 'error'], ['slow', 'error']]);
  assert.match(ran.value.results.find((r) => r.name === 'slow')?.evidence ?? '', /timed out/);
  assert.equal(ran.value.passed, false);
}));

test('recorded results are attestations about the commit at each check\'s version, so policy sees them', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/checks/ok.sh', script('ok', 'echo fine'));
  v.repo.write('.vault/checks/no.sh', script('no', 'exit 2'));
  v.repo.commit('checks');
  const accepted = v.accept();
  const head = v.propose({ 'a.md': 'a' });
  const ran = await runChecks(context(v), { commit: head, actor: 'gardener' }, options());
  assert.ok(ran.ok);
  assert.ok((await recordCheckResults(v.git, v.vault.path, head, ran.value.results, { ...TEST_ATTRIBUTION, date: v.clock.now() })).ok);

  const recorded = await readAttestations(v.git, v.vault.path, head);
  assert.ok(recorded.ok);
  const checks = await listScripts(v.git, v.vault.path, accepted, { kind: 'check', builtins: [] });
  assert.ok(checks.ok);
  const okCheck = checks.value.scripts.find((c) => c.name === 'ok');
  assert.deepEqual(recorded.value.find((a) => a.name === 'ok'), {
    kind: 'check', name: 'ok', subject: head, result: 'pass', by: '.vault/checks/ok.sh', version: okCheck?.version, evidence: 'fine', at: v.clock.now().toISOString(),
  });
  const statuses = checkStatuses({
    subject: head,
    checks: checks.value.scripts.map((c) => ({ name: c.name, version: c.version })),
    invalidChecks: [],
    attestations: { commit: recorded.value, content: new Map() },
  });
  assert.deepEqual(statuses, [{ name: 'no', status: 'fail' }, { name: 'ok', status: 'pass' }]);
}));

test('a vault without checks has nothing to run, and passes', withTestVault(async (v) => {
  v.accept();
  const head = v.propose({ 'a.md': 'a' });
  const ran = await runChecks(context(v), { commit: head, actor: 'gardener' }, options());
  assert.deepEqual(ran, { ok: true, value: { results: [], passed: true } });
}));
