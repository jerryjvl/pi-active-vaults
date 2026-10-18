// Documented behaviour: concepts.md "Merge policy" — a change to any
// `_contract.md`, anything under `.vault/`, or the `applies-when`, `budget` or
// `actor` of any document is a control change. Detection errs towards flagging: a
// spelling a case-insensitive file system treats as the same name counts, and
// so does frontmatter that cannot be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedPaths } from '../../../src/core/git/index.ts';
import { findControlChanges } from '../../../src/core/policy/index.ts';
import { gitFor, withTempRepo, type TempRepo } from '../../support/git-repo.ts';

const job = (fields: string, body = 'Do the thing.'): string => `---\n${fields}\n---\n${body}\n`;

async function flagged(repo: TempRepo, base: string, head: string): Promise<string[]> {
  const git = gitFor(repo);
  const changes = await changedPaths(git, repo.path, base, head);
  assert.ok(changes.ok);
  const control = await findControlChanges(git, repo.path, base, head, changes.value);
  assert.ok(control.ok);
  return control.value.map((c) => `${c.path} (${c.reason})`);
}

test('contracts anywhere and anything under .vault are control changes, however they are spelled', withTempRepo(async (repo) => {
  const base = repo.commit('base');
  repo.write('topics/_contract.md', job('index: none'));
  repo.write('.vault/scripts/x.sh', '#!/bin/sh\n');
  repo.write('deep/_Contract.md', 'case variant');
  repo.write('.VAULT/checks/y.sh', 'case variant');
  repo.write('notes/plain.md', job('labels: [a]'));
  const head = repo.commit('changes');
  assert.deepEqual(await flagged(repo, base, head), [
    '.VAULT/checks/y.sh (vault-directory)',
    '.vault/scripts/x.sh (vault-directory)',
    'deep/_Contract.md (contract)',
    'topics/_contract.md (contract)',
  ]);
}));

test('changing, adding or removing a document\'s applies-when or budget is a control change; other edits are not', withTempRepo(async (repo) => {
  repo.write('jobs/daily.md', job('applies-when: [{ on: timer, schedule: "0 6 * * *", effect: spawn }]\nbudget: { tokens: 1000, ttl: 10m }'));
  repo.write('jobs/budgeted.md', job('budget: { tokens: 1000, ttl: 10m }'));
  repo.write('jobs/old.md', job('applies-when: [{ on: merged, effect: spawn }]\nbudget: { tokens: 1, ttl: 1m }'));
  repo.write('notes/a.md', job('labels: [x]'));
  const base = repo.commit('base');
  repo.write('jobs/daily.md', job('applies-when: [{ on: timer, schedule: "0 6 * * *", effect: spawn }]\nbudget: { tokens: 1000, ttl: 10m }', 'Reworded prose only.'));
  repo.write('jobs/budgeted.md', job('budget: { tokens: 999999, ttl: 10m }'));
  repo.git('rm', '--quiet', 'jobs/old.md');
  repo.write('jobs/new.md', job('applies-when: [{ on: external, name: bell, effect: spawn }]\nbudget: { tokens: 1, ttl: 1m }'));
  repo.write('notes/a.md', job('labels: [x, y]', 'new labels are content, not control'));
  const head = repo.commit('changes');
  assert.deepEqual(await flagged(repo, base, head), [
    'jobs/budgeted.md (control-keys)',
    'jobs/new.md (control-keys)',
    'jobs/old.md (control-keys)',
  ]);
}));

test('a renamed job is compared with what it was; a rename onto a contract is a control change', withTempRepo(async (repo) => {
  repo.write('jobs/a.md', job('applies-when: [{ on: merged, effect: spawn }]\nbudget: { tokens: 1, ttl: 1m }'));
  repo.write('notes/n.md', job('index: none', 'A note long enough for Git to detect the rename by content.'));
  const base = repo.commit('base');
  repo.git('mv', 'jobs/a.md', 'jobs/b.md');
  repo.git('mv', 'notes/n.md', 'notes/_contract.md');
  const head = repo.commit('renames');
  assert.deepEqual(await flagged(repo, base, head), ['notes/_contract.md (contract)']);
}));

test('frontmatter that cannot be read is treated as a control change', withTempRepo(async (repo) => {
  repo.write('notes/a.md', job('labels: [x]'));
  const base = repo.commit('base');
  repo.write('notes/a.md', '---\napplies-when: [unclosed\n---\n');
  const head = repo.commit('broken');
  assert.deepEqual(await flagged(repo, base, head), ['notes/a.md (unreadable-frontmatter)']);
}));

test('changing a document\'s actor is a control change: it decides whom a job writes as', withTempRepo(async (repo) => {
  repo.write('jobs/a.md', job('applies-when: [{ on: merged, effect: spawn }]\nbudget: { tokens: 1, ttl: 1m }\nactor: gardener'));
  repo.write('jobs/b.md', job('labels: [x]'));
  const base = repo.commit('base');
  repo.write('jobs/a.md', job('applies-when: [{ on: merged, effect: spawn }]\nbudget: { tokens: 1, ttl: 1m }\nactor: librarian'));
  repo.write('jobs/b.md', job('labels: [x]\nactor: gardener'));
  const head = repo.commit('actors');
  assert.deepEqual(await flagged(repo, base, head), ['jobs/a.md (control-keys)', 'jobs/b.md (control-keys)']);
}));
