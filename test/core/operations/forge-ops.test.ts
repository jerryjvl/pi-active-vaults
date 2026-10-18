// Documented behaviour: cli.md — in forge mode, `vault propose <actor>` pushes
// the actor branch and opens or updates its pull request, and `vault sync`
// fetches first: the forge's main becomes the accepted main. concepts.md —
// the package never pushes main. Against a local bare repository behind the
// forge's URL and a stub forge API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import { mergeInForge, withForgeInstallation } from '../../support/forge-vault.ts';

test('propose pushes the actor branch and opens its pull request; sync takes the forge\'s main as the accepted main', withForgeInstallation(async (t, forge) => {
  assert.equal((await t.run('write', { path: 'notes/a.md', content: 'A', actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
  assert.equal((await t.run('commit', { message: 'A note', actor: 'gardener' })).status, 'ok');
  const proposed = await t.run('propose', { actor: 'gardener' });
  assert.equal(proposed.status, 'ok', proposed.text);
  assert.match(proposed.text, /^Opened pull request #1 \(.*\); vault\/policy: pending\.$/);
  const head = t.repo.git('rev-parse', 'refs/heads/actor/gardener');
  assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), head);
  assert.equal(forge.remote('rev-parse', 'refs/heads/main'), t.repo.git('rev-parse', 'refs/heads/main'), 'main is never pushed');

  const merged = mergeInForge(forge, { 'merged.md': 'merged in the forge' });
  const synced = await t.run('sync', {});
  assert.equal(synced.status, 'ok', synced.text);
  assert.match(synced.text, new RegExp(`the accepted main is ${merged}; main moved forward`));
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
}));
