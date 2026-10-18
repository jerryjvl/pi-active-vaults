// Documented behaviour: concepts.md "Built from the core" — a job is a
// document with a spawn condition and a budget; "Document" — a budget is
// required on any document that can spawn work, and so is an actor: the
// job's `actor`, else its nearest contract's, one of the vault's `actors` and
// never an owner. A job whose budget or actor cannot be read is listed with
// why and has none, so it cannot spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaultJobs } from '../../../src/core/queue/index.ts';
import { withTestVault } from '../../support/vault.ts';

const job = (fields = '') => `---\napplies-when:\n  - { on: external, name: go, effect: spawn }\nbudget: { tokens: 100, ttl: 90s }\n${fields}---\n`;

test('a vault\'s jobs are its documents that can spawn, with their budgets; injection alone is no job', withTestVault(async (v) => {
  v.repo.write('jobs/a.md', job('actor: gardener\n'));
  v.repo.write('jobs/b.md', '---\napplies-when:\n  - { on: external, name: go, effect: spawn }\nbudget: { tokens: 100 }\nactor: gardener\n---\n');
  v.repo.write('memory.md', '---\napplies-when:\n  - { on: session.start, effect: inject }\n---\n');
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.budget, j.issues.map((i) => i.path)]), [
    ['jobs/a.md', { tokens: 100, ttlMs: 90_000 }, []],
    ['jobs/b.md', undefined, ['budget.ttl']],
  ]);
}));

test('a job runs as its own actor, else its nearest contract\'s; only one of the vault\'s actors, never an owner', withTestVault(async (v) => {
  v.repo.write('jobs/_contract.md', '---\nactor: librarian\n---\n');
  v.repo.write('jobs/inherits.md', job());
  v.repo.write('jobs/own.md', job('actor: gardener\n'));
  v.repo.write('top.md', job());
  v.repo.write('loose/owner.md', job('actor: alice\n'));
  v.repo.write('loose/stranger.md', job('actor: mallory\n'));
  v.repo.write('loose/odd.md', job('actor: [gardener]\n'));
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.actor, j.issues.map((i) => `${i.path}: ${i.message}`)]), [
    ['jobs/inherits.md', 'librarian', []],
    ['jobs/own.md', 'gardener', []],
    ['loose/odd.md', undefined, ['actor: must be text']],
    ['loose/owner.md', undefined, ['actor: "alice" is not one of the vault\'s actors']],
    ['loose/stranger.md', undefined, ['actor: "mallory" is not one of the vault\'s actors']],
    ['top.md', 'gardener', []],
  ]);
}, { actors: ['gardener', 'librarian'], extra: 'actor: gardener' }));

test('a job with no actor anywhere cannot spawn, and says so', withTestVault(async (v) => {
  v.repo.write('jobs/none.md', job());
  v.repo.commit('job');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.actor, j.budget !== undefined, j.issues.map((i) => `${i.path}: ${i.message}`)]), [
    ['jobs/none.md', undefined, true, ['actor: is required on a document that can spawn work, in its frontmatter or a contract']],
  ]);
}));
