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
    ['loose/odd.md', undefined, ['actor: must be a non-empty string']],
    ['loose/owner.md', undefined, ['actor: is not one of the vault\'s actors']],
    ['loose/stranger.md', undefined, ['actor: is not one of the vault\'s actors']],
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

// concepts.md "Document": `model` names the `agent` model a job runs on — its own, else its nearest contract's.
test('a job asks for the model it names, else its nearest contract\'s, else none (the default agent); an unconfigured name is no problem here', withTestVault(async (v) => {
  v.repo.write('jobs/_contract.md', '---\nmodel: quick\n---\n');
  v.repo.write('jobs/inherits.md', job('actor: gardener\n'));
  v.repo.write('jobs/own.md', job('actor: gardener\nmodel: big\n'));
  v.repo.write('top.md', job('actor: gardener\n'));
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.model, j.terms?.model]), [
    ['jobs/inherits.md', 'quick', 'quick'],
    ['jobs/own.md', 'big', 'big'],
    ['top.md', undefined, undefined],
  ]);
}));

test('a job whose model is not a name cannot spawn, and says so', withTestVault(async (v) => {
  v.repo.write('jobs/list.md', job('actor: gardener\nmodel: [big]\n'));
  v.repo.write('jobs/spaced.md', job('actor: gardener\nmodel: "big model"\n'));
  v.repo.write('jobs/fine.md', job('actor: gardener\nmodel: big\n'));
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.terms !== undefined, j.issues.map((i) => `${i.path}: ${i.message}`)]), [
    ['jobs/fine.md', true, []],
    ['jobs/list.md', false, ['model: must be a non-empty string']],
    ['jobs/spaced.md', false, ['model: is not in the expected form']],
  ]);
}, { actors: ['gardener'] }));

test('a job\'s spawn terms are its budget, actor and model together; a job lacking one has none', withTestVault(async (v) => {
  v.repo.write('jobs/ok.md', job('actor: gardener\nmodel: big\n'));
  v.repo.write('jobs/no-actor.md', job());
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.terms]), [
    ['jobs/no-actor.md', undefined],
    ['jobs/ok.md', { budget: { tokens: 100, ttlMs: 90_000 }, actor: 'gardener', model: 'big' }],
  ]);
}, { actors: ['gardener'] }));

test('a job\'s own web block is read with it; one that is not exactly right is an issue and the job cannot spawn', withTestVault(async (v) => {
  v.repo.write('jobs/_contract.md', '---\nweb: { requests: 1, allow: [{ url: "https://inherited.example/*" }] }\n---\n');
  v.repo.write('jobs/fetches.md', job('actor: gardener\nweb:\n  requests: 4\n  allow:\n    - url: https://api.example.net/v3/{x}\n      x: [a, b]\n'));
  v.repo.write('jobs/inherits.md', job('actor: gardener\n'));
  v.repo.write('jobs/malformed.md', job('actor: gardener\nweb:\n  requests: 4\n  allow:\n    - url: https://user@example.net/\n'));
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  const [fetches, inherits, malformed] = jobs.value;
  assert.deepEqual(fetches?.web?.entries.map((e) => [e.url, e.params, e.open]), [['https://api.example.net/v3/{x}', { x: ['a', 'b'] }, false]]);
  assert.equal(inherits?.web, undefined, 'a web block is the document\'s own, never a contract\'s');
  assert.ok(inherits?.terms !== undefined);
  assert.equal(malformed?.terms, undefined, 'it cannot spawn');
  assert.deepEqual(malformed?.issues.map((i) => i.path), ['web.allow[0].url']);
}));
