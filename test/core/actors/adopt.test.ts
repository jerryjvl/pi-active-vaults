// Documented behaviour: security.md "Unexpected changes" and cli.md `vault
// accept --adopt` — adopting shows any failed checks and control changes in the
// delta from the accepted `main` first, and they must be acknowledged; then the
// commits and diff, flagging rewritten history; once an owner confirms, the
// SHA is recorded as accepted. With neither, it goes straight to the delta.
// Only an owner adopts, only `main`'s current tip, and never in forge mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adopt, adoptionDelta } from '../../../src/core/actors/index.ts';
import { recordAttestation } from '../../../src/core/attestations/index.ts';
import { acceptedMain, integrityStatus } from '../../../src/core/integrity/index.ts';
import { TEST_ATTRIBUTION } from '../../support/git-repo.ts';
import { rootContract, scriptSource, withTestVault } from '../../support/vault.ts';

test('a delta without failed checks or control changes goes straight to the commits and diff, then records the tip once an owner confirms', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  const before = accept();
  repo.write('stray.md', 'stray content\n');
  const stray = repo.commit('stray commit');
  const delta = await adoptionDelta(git, store, vault, stray);
  assert.ok(delta.ok);
  assert.equal(delta.value.from?.sha, before.sha);
  assert.deepEqual(delta.value.concerns, { checks: [], control: [] });
  assert.equal(delta.value.acknowledgement, undefined, 'nothing to acknowledge');
  assert.deepEqual(delta.value.commits.map((c) => c.sha), [stray]);
  assert.equal(delta.value.rewritten, false);
  assert.match(delta.value.diff, /\+stray content/);

  clock.advance(60_000);
  const adopted = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.ok(adopted.ok);
  assert.deepEqual({ ...adopted.value }, { vault: 'home', sha: stray, how: 'adopt', by: 'alice', at: '2026-01-01T00:01:00.000Z' });
  const status = await integrityStatus(git, store, vault);
  assert.equal(status.ok && status.value.state, 'accepted');
}));

test('control changes in the delta come first and must be acknowledged before the SHA is recorded', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  const before = accept();
  repo.write('_contract.md', rootContract({ extra: 'merge:\n  - { paths: ["**"], require: [checks] }' }));
  repo.write('.vault/scripts/fetch.sh', scriptSource('fetch'));
  repo.write('jobs/digest.md', '---\napplies-when:\n  - { on: timer, schedule: "0 6 * * *", effect: spawn }\nbudget: { tokens: 1000, ttl: 10m }\n---\nDigest.\n');
  const stray = repo.commit('stray control changes');
  const delta = await adoptionDelta(git, store, vault, stray);
  assert.ok(delta.ok);
  assert.deepEqual(delta.value.concerns.control.map((c) => c.path), ['.vault/scripts/fetch.sh', '_contract.md', 'jobs/digest.md']);
  assert.ok(delta.value.acknowledgement !== undefined);

  const unacknowledged = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.equal(!unacknowledged.ok && unacknowledged.error.reason, 'unacknowledged');
  const wrong = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock, acknowledged: 'f'.repeat(64) });
  assert.equal(!wrong.ok && wrong.error.reason, 'unacknowledged');
  assert.equal(acceptedMain(store, 'home')?.sha, before.sha, 'nothing recorded until acknowledged');

  const adopted = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock, acknowledged: delta.value.acknowledgement });
  assert.ok(adopted.ok);
}));

test('checks on the accepted main that have not passed for the SHA are concerns too; an acknowledgement is of exactly what was shown', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  repo.write('.vault/checks/links.sh', scriptSource('links'));
  repo.write('.vault/checks/spelling.sh', scriptSource('spelling'));
  repo.commit('checks');
  const accepted = accept();
  repo.write('notes.md', 'unchecked\n');
  const stray = repo.commit('stray');
  const version = (name: string) => repo.git('rev-parse', `${accepted.sha}:.vault/checks/${name}.sh`);
  const attest = (name: string, result: string, at: string) =>
    recordAttestation(git, repo.path, { kind: 'check', name, subject: stray, result, by: name, version: version(name), at }, TEST_ATTRIBUTION);
  assert.ok((await attest('links', 'fail', '2026-01-01T00:00:00.000Z')).ok);
  assert.ok((await attest('spelling', 'pass', '2026-01-01T00:00:00.000Z')).ok);

  const shown = await adoptionDelta(git, store, vault, stray);
  assert.ok(shown.ok);
  assert.deepEqual(shown.value.concerns, { checks: [{ name: 'links', status: 'fail' }], control: [] });

  // The check is re-run and now passes: what was acknowledged is no longer what is there.
  assert.ok((await attest('links', 'pass', '2026-01-01T00:05:00.000Z')).ok);
  const stale = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock, acknowledged: shown.value.acknowledgement });
  assert.equal(!stale.ok && stale.error.reason, 'unacknowledged');
  const now = await adoptionDelta(git, store, vault, stray);
  assert.ok(now.ok);
  assert.deepEqual(now.value.concerns.checks, []);
  assert.ok((await adopt(git, store, vault, { sha: stray, approver: 'alice', clock })).ok);
}));

test('adopting flags rewritten history', withTestVault(async ({ repo, git, store, vault, accept }) => {
  repo.write('a.md', 'a');
  repo.commit('a');
  accept();
  repo.git('reset', '--quiet', '--hard', 'HEAD~1');
  repo.write('b.md', 'b');
  const rewritten = repo.commit('rewrite');
  const delta = await adoptionDelta(git, store, vault, rewritten);
  assert.ok(delta.ok && delta.value.rewritten);
}));

test('only an owner can adopt, and only main\'s current tip', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  const before = accept();
  repo.write('stray.md', 'x');
  const stray = repo.commit('stray');
  const notOwner = await adopt(git, store, vault, { sha: stray, approver: 'gardener', clock });
  assert.equal(!notOwner.ok && notOwner.error.reason, 'not-owner');
  repo.write('more.md', 'y');
  repo.commit('main moved since');
  const moved = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.equal(!moved.ok && moved.error.reason, 'not-main-tip');
  assert.equal(acceptedMain(store, 'home')?.sha, before.sha);
}));

test('a forge-mode vault is never adopted locally', withTestVault(async ({ repo, git, store, vault, clock, accept }) => {
  accept();
  repo.write('stray.md', 'x');
  const stray = repo.commit('stray');
  const refused = await adopt(git, store, vault, { sha: stray, approver: 'alice', clock });
  assert.equal(!refused.ok && refused.error.reason, 'forge-mode');
}, { review: 'forge' }));

test('the first adoption of a newly registered vault takes its owners from the commit adopted, and its contract is a control change', withTestVault(async ({ git, store, vault, clock, initial }) => {
  const delta = await adoptionDelta(git, store, vault, initial);
  assert.ok(delta.ok);
  assert.deepEqual(delta.value.concerns.control.map((c) => c.path), ['_contract.md']);
  const acknowledged = delta.value.acknowledgement;
  const refused = await adopt(git, store, vault, { sha: initial, approver: 'mallory', clock, acknowledged });
  assert.equal(!refused.ok && refused.error.reason, 'not-owner');
  const adopted = await adopt(git, store, vault, { sha: initial, approver: 'alice', clock, acknowledged });
  assert.ok(adopted.ok);
}));
