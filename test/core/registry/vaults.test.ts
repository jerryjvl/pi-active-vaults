// Documented behaviour: the vaults on this machine (core.md "registry"):
// their paths and worktrees (architecture.md "Data locations"), the catalog
// (stable, ordered by vault ID — pi-conventions.md "Prompt-cache stability"),
// and which installation runs a vault's jobs (daemon.md "Hosting").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalog,
  checkRegisteredIdentity,
  hosting,
  registeredVaults,
  type RegisteredVault,
  type VaultIdentity,
} from '../../../src/core/registry/index.ts';

const vault = (overrides: Partial<VaultIdentity> = {}): VaultIdentity => ({
  id: 'home',
  purpose: { summary: 'Home things.', useFor: ['devices'], notFor: [] },
  audience: 'household',
  owners: ['alice'],
  actors: ['gardener'],
  review: 'local',
  ...overrides,
});

test('registered vaults keep their configured worktrees, or get their own under the state directory', () => {
  const config = {
    vaults: [
      { id: 'home', path: '/v/home', host: true },
      { id: 'work', path: '/v/work', worktrees: '/w/work', host: false },
    ],
  };
  assert.deepEqual(registeredVaults(config, { worktrees: '/s/worktrees' }, 'linux'), [
    { id: 'home', path: '/v/home', worktrees: '/s/worktrees/home', host: true },
    { id: 'work', path: '/v/work', worktrees: '/w/work', host: false },
  ]);
  const windows = registeredVaults({ vaults: [{ id: 'home', path: 'C:\\v\\home', host: false }] }, { worktrees: 'C:\\s\\worktrees' }, 'win32');
  assert.equal(windows[0]?.worktrees, 'C:\\s\\worktrees\\home');
});

test('the catalog lists each vault\'s purpose and audience, ordered by vault ID', () => {
  assert.deepEqual(catalog([vault({ id: 'work', audience: 'team' }), vault()]), [
    { id: 'home', summary: 'Home things.', useFor: ['devices'], notFor: [], audience: 'household' },
    { id: 'work', summary: 'Home things.', useFor: ['devices'], notFor: [], audience: 'team' },
  ]);
});

test('jobs run here only when opted in, or when the vault names this installation as its executor', () => {
  const entry = (host: boolean): RegisteredVault => ({ id: 'home', path: '/v', worktrees: '/w', host });
  const executor = (name?: string): VaultIdentity => (name === undefined ? vault() : vault({ executor: name }));
  assert.deepEqual(hosting(entry(false), executor(), 'alice@laptop'), { runsHere: false, conflict: false });
  assert.deepEqual(hosting(entry(true), executor(), 'alice@laptop'), { runsHere: true, conflict: false });
  assert.deepEqual(hosting(entry(false), executor('alice@laptop'), 'alice@laptop'), { runsHere: true, conflict: false });
  assert.deepEqual(hosting(entry(false), executor('alice@server'), 'alice@laptop'), { runsHere: false, conflict: false });
  assert.deepEqual(hosting(entry(true), executor('alice@server'), 'alice@laptop'), { runsHere: false, conflict: true });
});

test('a vault whose root contract names another id than its registration is refused', () => {
  const entry: RegisteredVault = { id: 'home', path: '/v', worktrees: '/w', host: false };
  assert.deepEqual(checkRegisteredIdentity(entry, vault()), { ok: true, value: undefined });
  assert.deepEqual(checkRegisteredIdentity(entry, vault({ id: 'other' })), {
    ok: false,
    error: { reason: 'id-mismatch', registered: 'home', declared: 'other' },
  });
});
