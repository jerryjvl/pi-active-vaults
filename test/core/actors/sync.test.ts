// Documented behaviour: cli.md "vault sync" — actor branches are brought up to
// date with `main`: the accepted `main`, since nothing else may be built on.
// A branch with no work of its own moves forward; one with work gets a merge
// commit that carries the package's trailers (so it is not mistaken for
// outside work) and is assessed by the checks like any commit. Syncing writes
// as the actor, so not while another session holds it, and never over
// uncommitted changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureActorWorktree, isTaintedCommit, syncActorBranch, takeActorHold } from '../../../src/core/actors/index.ts';
import { readAttestations } from '../../../src/core/attestations/index.ts';
import { commitsBetween } from '../../../src/core/git/index.ts';
import type { ProcessLiveness } from '../../../src/core/process/index.ts';
import { TEST_ATTRIBUTION } from '../../support/git-repo.ts';
import { scriptSource, withTestVault, type TestVault } from '../../support/vault.ts';

const running = (live: Record<number, string>): ProcessLiveness => async (pid) => ({ ok: true, value: live[pid] });
const context = (v: TestVault, alive: ProcessLiveness = running({})) => ({
  git: v.git, store: v.store, alive, clock: v.clock, attribution: TEST_ATTRIBUTION,
  checks: { env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 10_000, os: 'linux', sandbox: 'none' } as const,
});
const origin = { trace: '01SYNC', actor: 'gardener' };
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };

/** Accepts a new commit on main, as an owner's accept would leave it. */
function advanceMain(v: TestVault, path: string): string {
  v.repo.write(path, path);
  v.repo.commit(`Add ${path}`);
  return v.accept().sha;
}

test('a branch with no work of its own moves forward to the accepted main; one already there is up to date', withTestVault(async (v) => {
  const first = v.accept();
  const made = await ensureActorWorktree(v.git, v.vault, first, 'gardener');
  assert.ok(made.ok);
  const sha = advanceMain(v, 'news.md');
  const accepted = v.accept();
  const synced = await syncActorBranch(context(v), v.vault, accepted, 'gardener', { origin, date: v.clock.now() });
  assert.deepEqual(synced, { ok: true, value: { outcome: 'fast-forwarded', head: sha } });
  assert.equal(v.repo.git('rev-parse', 'refs/heads/actor/gardener'), sha);
  const again = await syncActorBranch(context(v), v.vault, accepted, 'gardener', { origin, date: v.clock.now() });
  assert.deepEqual(again, { ok: true, value: { outcome: 'up-to-date', head: sha } });
  assert.deepEqual(await syncActorBranch(context(v), v.vault, accepted, 'librarian', { origin, date: v.clock.now() }), { ok: true, value: { outcome: 'no-branch' } });
}));

test('a branch with its own work gets a merge commit with the package\'s trailers, assessed and recorded by the checks', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/checks/ok.sh', scriptSource('ok', 'echo fine'));
  v.repo.commit('a check');
  v.accept();
  const work = v.propose({ 'notes/mine.md': 'mine' });
  const accepted = v.accept(advanceMain(v, 'news.md'));
  const synced = await syncActorBranch(context(v), v.vault, accepted, 'gardener', { origin, date: v.clock.now() });
  assert.ok(synced.ok && synced.value.outcome === 'merged', JSON.stringify(synced));
  const head = synced.value.head ?? '';
  assert.equal(v.repo.git('rev-parse', `${head}^1`), work);
  assert.equal(v.repo.git('rev-parse', `${head}^2`), accepted.sha);
  const commits = await commitsBetween(v.git, v.vault.path, accepted.sha, head);
  assert.ok(commits.ok);
  assert.equal(isTaintedCommit(commits.value.at(-1) ?? { trailers: [] }), false, 'the merge carries the package\'s trailers');
  assert.deepEqual(synced.value.checks?.map((c) => [c.name, c.result]), [['ok', 'pass']]);
  const recorded = await readAttestations(v.git, v.vault.path, head);
  assert.deepEqual(recorded.ok && recorded.value.map((a) => [a.name, a.result]), [['ok', 'pass']]);
}));

test('syncing is refused while another session holds the actor, and leaves uncommitted changes alone', withTestVault(async (v) => {
  const first = v.accept();
  const made = await ensureActorWorktree(v.git, v.vault, first, 'gardener');
  assert.ok(made.ok);
  const accepted = v.accept(advanceMain(v, 'news.md'));
  const holder = { process: { pid: 7, started: 's' }, session: 'S' };
  const live = running({ 7: 's' });
  assert.ok((await takeActorHold(v.store, live, v.clock, { vault: v.vault.id, actor: 'gardener', holder })).ok);
  const busy = await syncActorBranch(context(v, live), v.vault, accepted, 'gardener', { origin, date: v.clock.now() });
  assert.equal(!busy.ok && busy.error.reason, 'actor-busy');
  assert.equal(v.repo.git('rev-parse', 'refs/heads/actor/gardener'), first.sha);

  writeFileSync(join(made.value.path, '_contract.md'), 'edited, not committed');
  const dirty = await syncActorBranch(context(v), v.vault, accepted, 'gardener', { origin, date: v.clock.now() });
  assert.deepEqual(dirty, { ok: true, value: { outcome: 'uncommitted-changes', head: first.sha } });
  assert.equal(v.repo.git('rev-parse', 'refs/heads/actor/gardener'), first.sha);
}));
