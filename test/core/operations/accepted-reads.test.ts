// Documented behaviour: architecture.md "Reads from the accepted main" — one
// cache for what is read from a vault's accepted main, kept for as long as
// the process that reads it (a CLI command, a Pi session, the daemon): the
// accepted SHA is looked up on each operation, so an accept is picked up by
// the next read and an unaccepted change never is; nothing is re-read while
// the accepted main is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import { vaultJobs } from '../../../src/core/queue/index.ts';
import { withInstallation } from '../../support/installation.ts';

const job = (name: string) => `---\napplies-when: [{ on: external, name: ${name}, effect: spawn }]\nbudget: { tokens: 100, ttl: 1m }\nactor: gardener\n---\n`;

test('within one context, an accept is picked up by the next read and an unaccepted change never is', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', job('a'));
  t.accept(t.repo.commit('a'));
  assert.match((await t.run('jobs')).text, /jobs\/a\.md/);

  t.repo.write('jobs/b.md', job('b'));
  const b = t.repo.commit('b');
  assert.doesNotMatch((await t.run('jobs')).text, /jobs\/b\.md/, 'unaccepted: not read');
  t.accept(b);
  assert.match((await t.run('jobs')).text, /jobs\/b\.md/, 'accepted: read on the next operation');

  t.repo.write('jobs/c.md', job('c'));
  t.repo.write('jobs/_contract.md', '---\nindex: none\n---\nUnaccepted rules.\n');
  t.repo.commit('c');
  assert.doesNotMatch((await t.run('jobs')).text, /jobs\/c\.md/);
  assert.doesNotMatch((await t.run('contract', { path: 'jobs/c.md' })).text, /Unaccepted rules/);
}));

test('while the accepted main is unchanged, what was read from it is not read again', withInstallation(async (t) => {
  t.repo.write('jobs/a.md', job('a'));
  t.accept(t.repo.commit('a'));
  const accepted = acceptedMain(t.context.state, 'home');
  assert.ok(accepted !== undefined);
  const first = await vaultJobs(t.context.git, t.vault.path, accepted, t.context.reads);
  const again = await vaultJobs(t.context.git, t.vault.path, acceptedMain(t.context.state, 'home') ?? accepted, t.context.reads);
  assert.ok(first.ok && again.ok);
  assert.equal(again.value, first.value, 'the very same read');
}));
