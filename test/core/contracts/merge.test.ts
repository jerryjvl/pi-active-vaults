// Documented behaviour: concepts.md "Contracts" — a directory's effective
// contract merges every `_contract.md` from the root down, each key by its
// strategy (nearest, merge, list-ops, tighten-only, locked), and reports the
// origin of each key. An invalid contract is an error, never partly applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyListOps, mergeContracts, type ContractFile } from '../../../src/core/contracts/index.ts';

const root = (frontmatter: Record<string, unknown>, body = ''): ContractFile => ({ path: '_contract.md', frontmatter, body });
const at = (dir: string, frontmatter: Record<string, unknown>, body = ''): ContractFile => ({ path: `${dir}/_contract.md`, frontmatter, body });

function merged(...chain: ContractFile[]) {
  const result = mergeContracts(chain);
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

const issues = (...chain: ContractFile[]): string[] => {
  const result = mergeContracts(chain);
  return result.ok ? [] : result.error.map((i) => `${i.path}: ${i.message}`);
};

test('no contracts give an empty effective contract', () => {
  assert.deepEqual(merged(), { values: {}, origins: {}, prose: [], contracts: [] });
});

test('nearest: the deepest value wins and is its origin', () => {
  const c = merged(root({ naming: '{topic}.md', index: 'default' }), at('topics', { naming: '{topic}-{date}.md' }));
  assert.deepEqual(c.values, { naming: '{topic}-{date}.md', index: 'default' });
  assert.deepEqual(c.origins, { naming: ['topics/_contract.md'], index: ['_contract.md'] });
});

test('merge: maps merge key by key, a deeper entry replacing one of the same name', () => {
  const quality = { type: 'bool', instructions: 'Is it accurate?', 'pass-when': 'yes > 0.8' };
  const stricter = { type: 'bool', instructions: 'Is it accurate and sourced?', 'pass-when': 'yes > 0.9' };
  const tone = { type: 'choice', instructions: 'Tone?', options: ['plain', 'florid'], 'pass-when': 'plain > 0.5' };
  const c = merged(root({ axes: { quality, tone } }), at('topics', { axes: { quality: stricter } }));
  assert.deepEqual(c.values['axes'], { quality: stricter, tone });
  assert.deepEqual(c.origins['axes'], ['_contract.md', 'topics/_contract.md']);
});

test('list-ops: a plain list replaces, and its contract becomes the only origin', () => {
  const daily = { on: 'timer', schedule: '0 6 * * *', effect: 'spawn' };
  const c = merged(root({ 'applies-when': [daily] }), at('topics', { 'applies-when': [] }));
  assert.deepEqual(c.values['applies-when'], []);
  assert.deepEqual(c.origins['applies-when'], ['topics/_contract.md']);
});

test('list-ops: +/- edit the inherited list; a mapping is removed only by an equal one', () => {
  const daily = { on: 'timer', schedule: '0 6 * * *', effect: 'spawn' };
  const merges = { on: 'merged', effect: 'spawn' };
  const onPath = { on: 'session.path', paths: ['topics/**'], effect: 'inject' };
  const c = merged(
    root({ 'applies-when': [daily, merges] }),
    at('topics', { 'applies-when': [{ '-': { ...daily, schedule: '0 7 * * *' } }, { '-': merges }, { '+': onPath }, { '+': onPath }] }),
  );
  assert.deepEqual(c.values['applies-when'], [daily, onPath]);
  assert.deepEqual(c.origins['applies-when'], ['_contract.md', 'topics/_contract.md']);
});

test('list-ops on names, as MCP permissions use it', () => {
  assert.deepEqual(applyListOps(['read', 'propose'], ['+review', '-propose']), { ok: true, value: ['read', 'review'] });
  assert.deepEqual(applyListOps(['read'], []), { ok: true, value: [] });
  assert.deepEqual(applyListOps(['read'], ['search']), { ok: true, value: ['search'] });
  assert.equal(applyListOps(['read'], ['+review', 'search']).ok, false, 'edits and plain items do not mix');
  assert.equal(applyListOps(['read'], ['+']).ok, false);
  assert.equal(applyListOps(['read'], 'review').ok, false);
});

test('tighten-only: deeper merge rules add to the inherited ones and cannot remove them', () => {
  const all = { paths: ['**'], require: ['checks', 'owner'] };
  const topics = { paths: ['topics/**'], require: ['judgement:quality'] };
  const c = merged(root({ merge: [all] }), at('topics', { merge: [topics] }), at('topics/cars', { merge: [] }));
  assert.deepEqual(c.values['merge'], [all, topics]);
  assert.deepEqual(c.origins['merge'], ['_contract.md', 'topics/_contract.md']);
});

test('locked: only the root contract may set the vault identity or the template marker', () => {
  const vault = { id: 'home', owners: ['alice'] };
  assert.deepEqual(merged(root({ vault })).values, { vault });
  assert.deepEqual(issues(root({ vault }), at('topics', { vault: { id: 'other' }, template: { name: 't' } })), [
    'topics/_contract.md:vault: may be set only in the root contract',
    'topics/_contract.md:template: may be set only in the root contract',
  ]);
});

test('any other key is the vault\'s own and merges nearest', () => {
  const c = merged(root({ colour: 'blue', tags: ['a'] }), at('x', { tags: ['b'] }));
  assert.deepEqual(c.values, { colour: 'blue', tags: ['b'] });
});

test('values of the wrong shape are errors naming the contract and key, all reported', () => {
  assert.deepEqual(issues(
    root({ merge: { paths: ['**'] }, index: 'sometimes', axes: ['quality'] }),
    at('a', { 'applies-when': { on: 'merged' }, naming: 7 }),
  ), [
    '_contract.md:merge: must be a list',
    '_contract.md:index: must be one of default, opt-in, none',
    '_contract.md:axes: must be a mapping of names to mappings',
    'a/_contract.md:applies-when: must be a list',
    'a/_contract.md:naming: must be a non-empty string',
  ]);
});

test('prose of every governing contract is kept, root first, and the chain is listed', () => {
  const c = merged(root({}, '\nRoot rules.\n'), at('topics', {}, ''), at('topics/cars', {}, 'Car rules.\n'));
  assert.deepEqual(c.prose, [
    { path: '_contract.md', body: '\nRoot rules.\n' },
    { path: 'topics/cars/_contract.md', body: 'Car rules.\n' },
  ]);
  assert.deepEqual(c.contracts, ['_contract.md', 'topics/_contract.md', 'topics/cars/_contract.md']);
});

test('nearest: a job\'s model, like its actor, is the deepest contract\'s', () => {
  const c = merged(root({ actor: 'gardener', model: 'big' }), at('jobs', { model: 'quick' }));
  assert.deepEqual(c.values, { actor: 'gardener', model: 'quick' });
  assert.deepEqual(c.origins['model'], ['jobs/_contract.md']);
});
