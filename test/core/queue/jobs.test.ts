// Documented behaviour: concepts.md "Built from the core" — a job is a
// document with a spawn condition and a budget; "Document" — a budget is
// required on any document that can spawn work. A job whose budget cannot be
// read is listed with why and has none, so it cannot spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vaultJobs } from '../../../src/core/queue/index.ts';
import { withTestVault } from '../../support/vault.ts';

test('a vault\'s jobs are its documents that can spawn, with their budgets; injection alone is no job', withTestVault(async (v) => {
  v.repo.write('jobs/a.md', '---\napplies-when:\n  - { on: external, name: go, effect: spawn }\nbudget: { tokens: 100, ttl: 90s }\n---\n');
  v.repo.write('jobs/b.md', '---\napplies-when:\n  - { on: external, name: go, effect: spawn }\nbudget: { tokens: 100 }\n---\n');
  v.repo.write('memory.md', '---\napplies-when:\n  - { on: session.start, effect: inject }\n---\n');
  v.repo.commit('jobs');
  const jobs = await vaultJobs(v.git, v.vault.path, v.accept());
  assert.ok(jobs.ok);
  assert.deepEqual(jobs.value.map((j) => [j.path, j.budget, j.issues.map((i) => i.path)]), [
    ['jobs/a.md', { tokens: 100, ttlMs: 90_000 }, []],
    ['jobs/b.md', undefined, ['budget.ttl']],
  ]);
}));
