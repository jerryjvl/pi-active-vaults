// Documented behaviour: extension.md "Taint" — a session is tainted once it
// uses any tool not in the installation's `taint.trusted-tools`, or reads a
// file outside the registered vaults; unknown tools taint, so the check fails
// closed. Commits from a tainted session carry `Vault-Tainted`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { taints } from '../../../src/core/sessions/index.ts';
import type { RegisteredVault } from '../../../src/core/registry/index.ts';

const vaults: RegisteredVault[] = [{ id: 'home', path: '/v/home', worktrees: '/w/home', host: false }];
const trusted = { trustedTools: ['read', 'edit', 'write', 'vault_search', 'vault_read'] };

test('a tool not in the trusted list taints the session; with no list, every tool does', () => {
  assert.equal(taints(trusted, vaults, { tool: 'web_fetch' }), true);
  assert.equal(taints(trusted, vaults, { tool: 'bash' }), true);
  assert.equal(taints(trusted, vaults, { tool: 'vault_search' }), false);
  assert.equal(taints({ trustedTools: [] }, vaults, { tool: 'read', reads: ['/v/home/a.md'] }), true);
});

test('a trusted tool reading inside a vault — its checkout or a worktree — does not taint; reading anywhere else does', () => {
  assert.equal(taints(trusted, vaults, { tool: 'read', reads: [join('/v/home', 'notes', 'a.md')] }), false);
  assert.equal(taints(trusted, vaults, { tool: 'read', reads: [join('/w/home', 'gardener', 'a.md')] }), false);
  assert.equal(taints(trusted, vaults, { tool: 'read', reads: ['/etc/hosts'] }), true);
  assert.equal(taints(trusted, vaults, { tool: 'edit', reads: ['/v/home/a.md', '/tmp/x'] }), true, 'any read outside taints');
  assert.equal(taints(trusted, vaults, { tool: 'read', reads: ['/v/homework/a.md'] }), true, 'a sibling directory is not inside');
});
