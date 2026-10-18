// Documented behaviour: concepts.md "applies-when" and "Contracts" — a
// document's conditions are its own `applies-when`, plus the `applies-when`
// of its effective contract, which applies to every document in the subtree.
// security.md — conditions come from the accepted `main` only, never a branch
// or the working tree. A condition that cannot be read applies nowhere and is
// reported. `_contract.md` files and `.vault/` hold no jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentConditions } from '../../../src/core/conditions/index.ts';
import { withTestVault } from '../../support/vault.ts';

const job = (fields: string) => `---\n${fields}\n---\nThe job.\n`;
const timer = 'applies-when:\n  - { on: timer, schedule: "30 6 * * *", effect: spawn }\nbudget: { tokens: 1000, ttl: 5m }';

test('documents on the accepted main are listed with their conditions; a branch\'s or the working tree\'s are not', withTestVault(async (v) => {
  v.repo.write('jobs/daily.md', job(timer));
  v.repo.write('notes/plain.md', '# No conditions\n');
  v.repo.commit('a job');
  const accepted = v.accept();
  v.propose({ 'jobs/proposed.md': job(timer) });
  v.repo.write('jobs/uncommitted.md', job(timer));

  const listed = await documentConditions(v.git, v.vault.path, accepted);
  assert.ok(listed.ok, JSON.stringify(listed));
  assert.deepEqual(listed.value.map((d) => [d.path, d.conditions.map((c) => c.on), d.issues]), [['jobs/daily.md', ['timer'], []]]);
  assert.deepEqual(listed.value[0]?.budget, { tokens: 1000, ttl: '5m' });
}));

test('a contract\'s conditions apply to every document below it, after the document\'s own', withTestVault(async (v) => {
  v.repo.write('topics/_contract.md', '---\napplies-when:\n  - { on: session.path, paths: ["topics/**"], effect: inject }\n---\n');
  v.repo.write('topics/cars.md', job('applies-when:\n  - { on: external, name: refresh, effect: spawn }\nbudget: { tokens: 10, ttl: 1m }'));
  v.repo.write('topics/boats.md', '# Boats\n');
  v.repo.write('elsewhere.md', '# Not governed\n');
  v.repo.commit('topics');
  const listed = await documentConditions(v.git, v.vault.path, v.accept());
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((d) => [d.path, d.conditions.map((c) => `${c.on}:${c.effect}`)]), [
    ['topics/boats.md', ['session.path:inject']],
    ['topics/cars.md', ['external:spawn', 'session.path:inject']],
  ]);
}));

test('conditions that cannot be read apply nowhere, and say why', withTestVault(async (v) => {
  v.repo.write('jobs/typo.md', job('applies-when:\n  - { on: timer, schedul: "* * * * *", effect: spawn }'));
  v.repo.write('jobs/broken.md', '---\napplies-when: [unclosed\n---\n');
  v.repo.write('bad/_contract.md', '---\nindex: sometimes\n---\n');
  v.repo.write('bad/inside.md', job(timer));
  v.repo.write('.vault/jobs/hidden.md', job(timer));
  v.repo.commit('problems');
  const listed = await documentConditions(v.git, v.vault.path, v.accept());
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((d) => [d.path, d.conditions.length, d.issues.length > 0]), [
    ['bad/inside.md', 0, true],
    ['jobs/broken.md', 0, true],
    ['jobs/typo.md', 0, true],
  ]);
  assert.match(listed.value[2]?.issues[0]?.path ?? '', /^jobs\/typo\.md:applies-when\[0\]/);
}));

test('a document\'s actor is its own, else its nearest contract\'s, with where it comes from', withTestVault(async (v) => {
  v.repo.write('jobs/_contract.md', '---\nactor: librarian\n---\n');
  v.repo.write('jobs/inherits.md', job(timer));
  v.repo.write('jobs/own.md', job(`${timer}\nactor: gardener`));
  v.repo.write('top.md', job(timer));
  v.repo.commit('jobs');
  const listed = await documentConditions(v.git, v.vault.path, v.accept());
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.map((d) => [d.path, d.actor]), [
    ['jobs/inherits.md', { value: 'librarian', origin: 'jobs/_contract.md' }],
    ['jobs/own.md', { value: 'gardener', origin: 'jobs/own.md' }],
    ['top.md', undefined],
  ]);
}));
