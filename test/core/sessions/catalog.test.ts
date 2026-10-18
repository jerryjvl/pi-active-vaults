// Documented behaviour: extension.md "Session lifecycle" (`before_agent_start`)
// and pi-conventions.md "Prompt-cache stability" — the vault catalog is added
// to the system prompt, ordered by vault ID, with no changing values; it is
// read from each vault's accepted `main`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { catalogText } from '../../../src/core/sessions/index.ts';
import { withInstallation } from '../../support/installation.ts';
import { rootContract } from '../../support/vault.ts';

test('the catalog names each vault with its purpose, from its accepted main, the same every time', withInstallation(async (t) => {
  const text = await catalogText(t.context);
  assert.match(text, /home: Home things\./);
  assert.match(text, /vault_search/, 'it says how to reach them');
  t.repo.write('_contract.md', rootContract().replace('Home things.', 'Unaccepted purpose.'));
  t.repo.commit('unaccepted');
  assert.equal(await catalogText(t.context), text);
}));

test('vaults are listed by ID, and one that cannot be read is named as such', withInstallation(async (t) => {
  const zeta = t.dir.file('zeta');
  mkdirSync(zeta);
  const vaults = [{ id: 'zeta', path: zeta, worktrees: zeta, host: false }, t.vault];
  const text = await catalogText({ ...t.context, installation: { ...t.installation, vaults } });
  assert.ok(text.indexOf('home:') < text.indexOf('zeta:'), text);
  assert.match(text, /zeta: \(cannot be read\)/);
}));
