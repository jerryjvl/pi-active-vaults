// Documented behaviour: architecture.md "Reads from the accepted main" — a
// Pi session picks up an accept made while it runs on its next read, and
// never an unaccepted change; pi-conventions.md "Prompt-cache stability" —
// the vault catalog is the exception: fixed at session start, changes take
// effect in the next session. Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInstallation } from '../support/installation.ts';
import { DONE, toolCall, toolResults, withPi } from '../support/pi.ts';
import { RUNNING } from '../support/session.ts';
import { rootContract } from '../support/vault.ts';

test('an accept mid-session is read on the next call; an unaccepted change never is; the catalog stays as it started', withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    t.repo.write('_contract.md', rootContract().replace('Home things.', 'Changed purpose.'));
    t.repo.write('topics/_contract.md', '---\nindex: default\n---\nAccepted topic rules.\n');
    t.accept(t.repo.commit('topics'));
    t.repo.write('notes/_contract.md', '---\nindex: default\n---\nUnaccepted note rules.\n');
    t.repo.commit('notes, unaccepted');

    pi.respond(toolCall('vault_read', { path: 'home:topics/x.md' }), toolCall('vault_read', { path: 'home:notes/y.md' }), DONE);
    await pi.prompt('Read.');
    const last = pi.requests.at(-1);
    assert.match(toolResults(last, 'vault_read').join('\n'), /Accepted topic rules\./);
    assert.doesNotMatch(JSON.stringify(last?.messages), /Unaccepted note rules/);
    assert.match(last?.system ?? '', /- home: Home things\./, 'the catalog is fixed for the session');
    assert.doesNotMatch(last?.system ?? '', /Changed purpose/);
  });
}, { running: RUNNING }));
