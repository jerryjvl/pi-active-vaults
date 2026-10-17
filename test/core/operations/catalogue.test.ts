// Documented behaviour: principle 17 and core.md `operations` — one catalogue
// of operations, from which every surface is generated; an operation's name is
// its permission (mcp.md). api.md — the Pi tools and their exposure, and
// judgements and acceptance are deliberately not tools: the model must not
// judge or approve its own work. Parameters are checked before an operation
// runs; vaults are chosen the same way for every surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, PERMISSIONS, checkParams, chooseVaults, operationNamed, paramsOn, placeVaultPaths } from '../../../src/core/operations/index.ts';
import type { RegisteredVault } from '../../../src/core/registry/index.ts';

test('every operation is named once; those offered over MCP are exactly the permissions', () => {
  const names = CATALOGUE.map((o) => o.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(CATALOGUE.filter((o) => o.surfaces.mcp).map((o) => o.name), [...PERMISSIONS]);
});

test('the Pi tools are the documented ones, with their exposure; nothing that judges or approves is a tool', () => {
  const tools = Object.fromEntries(CATALOGUE.filter((o) => o.surfaces.tool !== undefined).map((o) => [`vault_${o.name}`, o.surfaces.tool]));
  assert.deepEqual(tools, { vault_search: 'direct', vault_read: 'direct', vault_contract: 'codemode', vault_jobs: 'codemode', vault_commit: 'direct', vault_script: 'direct' });
  for (const name of ['accept', 'review', 'adopt', 'judge']) assert.equal(operationNamed(name)?.surfaces.tool, undefined, name);
});

test('the Pi commands are the documented ones', () => {
  assert.deepEqual(CATALOGUE.filter((o) => o.surfaces.command).map((o) => o.name).sort(), ['accept', 'contract', 'doctor', 'jobs', 'review', 'run', 'status', 'trace']);
});

test('a model is never offered a parameter choosing whom it writes as', () => {
  for (const operation of CATALOGUE.filter((o) => o.surfaces.tool !== undefined)) {
    assert.equal(paramsOn(operation, 'tool').some((p) => p.name === 'actor'), false, operation.name);
  }
});

test('every parameter is described, and a positional list comes last', () => {
  for (const operation of CATALOGUE) {
    assert.ok(operation.summary.length > 0, operation.name);
    for (const param of operation.params) assert.ok(param.description.length > 0, `${operation.name}.${param.name}`);
    const positional = operation.params.filter((p) => p.positional === true);
    assert.ok(positional.slice(0, -1).every((p) => p.kind !== 'strings'), operation.name);
  }
});

test('parameters are checked against their specs: unknown, wrong kind, missing, outside the choices — every problem, nothing coerced', () => {
  const commit = operationNamed('commit');
  const notify = operationNamed('notify');
  assert.ok(commit !== undefined && notify !== undefined);
  assert.deepEqual(checkParams(commit, 'cli', { message: 'x', paths: ['a.md'] }), { ok: true, value: { message: 'x', paths: ['a.md'] } });
  const bad = checkParams(commit, 'cli', { paths: 'a.md', force: true });
  assert.deepEqual(!bad.ok && bad.error.map((i) => `${i.path}: ${i.message}`), ['force: is not a parameter of this operation', 'message: is required', 'paths: must be a list of strings']);
  const asTool = checkParams(commit, 'tool', { message: 'x', actor: 'alice' });
  assert.deepEqual(!asTool.ok && asTool.error.map((i) => i.path), ['actor'], 'a tool call cannot name an actor');
  const choice = checkParams(notify, 'cli', { action: 'send', to: 'me' });
  assert.deepEqual(!choice.ok && choice.error.map((i) => i.message), ['must be one of: test']);
  assert.equal(checkParams(operationNamed('search') ?? commit, 'cli', { query: 'x', limit: 1.5 }).ok, false);
});

const home: RegisteredVault = { id: 'home', path: '/v/home', worktrees: '/w/home', host: false };
const work: RegisteredVault = { id: 'work', path: '/v/work', worktrees: '/w/work', host: false };
const installation = { vaults: [home, work] };

test('vaults are chosen alike everywhere: those named, else where the caller is, else — over many — every one', () => {
  const op = (name: string) => {
    const found = operationNamed(name);
    assert.ok(found !== undefined);
    return found;
  };
  assert.deepEqual(chooseVaults(installation, op('read'), ['work'], home), { ok: true, value: [work] });
  assert.deepEqual(chooseVaults(installation, op('read'), [], home), { ok: true, value: [home] });
  assert.deepEqual(chooseVaults(installation, op('read'), []), { ok: false, error: { reason: 'which-vault', operation: 'read' } });
  assert.deepEqual(chooseVaults(installation, op('read'), ['home', 'work']), { ok: false, error: { reason: 'which-vault', operation: 'read' } });
  assert.deepEqual(chooseVaults(installation, op('notify'), []), { ok: true, value: [] });
  assert.deepEqual(chooseVaults(installation, op('search'), [], home), { ok: true, value: [home, work] });
  assert.deepEqual(chooseVaults(installation, op('search'), ['work']), { ok: true, value: [work] });
  assert.deepEqual(chooseVaults(installation, op('whoami'), ['work']), { ok: true, value: [] });
  assert.deepEqual(chooseVaults(installation, op('read'), ['elsewhere']), { ok: false, error: { reason: 'unknown-vault', vault: 'elsewhere' } });
});

test('a vault path names its vault with <vault-id>:, or is relative to where the caller is in that vault', () => {
  const read = operationNamed('read');
  assert.ok(read !== undefined);
  assert.deepEqual(placeVaultPaths(installation, read, 'cli', { path: 'work:notes/a.md' }, []), { params: { path: 'notes/a.md' }, named: ['work'] });
  assert.deepEqual(placeVaultPaths(installation, read, 'cli', { path: 'a.md' }, [], { vault: home, path: 'notes' }), { params: { path: 'notes/a.md' }, named: [] });
  assert.deepEqual(placeVaultPaths(installation, read, 'cli', { path: 'a.md' }, ['work'], { vault: home, path: 'notes' }), { params: { path: 'a.md' }, named: ['work'] }, 'another vault named: not relative to here');
  assert.deepEqual(placeVaultPaths(installation, read, 'cli', { path: 'C:notes.md' }, []), { params: { path: 'C:notes.md' }, named: [] }, 'only a registered vault\'s prefix counts');
});
