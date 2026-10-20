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
  assert.match(proposed.text, /^Opened pull request #1 \(.*\); vault\/policy: pending\.\nThe forge merges it once it is approved and vault\/policy passes\.$/);
  const head = t.repo.git('rev-parse', 'refs/heads/actor/gardener');
  assert.equal(forge.remote('rev-parse', 'refs/heads/actor/gardener'), head);
  assert.equal(forge.remote('rev-parse', 'refs/heads/main'), t.repo.git('rev-parse', 'refs/heads/main'), 'main is never pushed');

  const merged = mergeInForge(forge, { 'merged.md': 'merged in the forge' });
  const synced = await t.run('sync', {});
  assert.equal(synced.status, 'ok', synced.text);
  assert.match(synced.text, new RegExp(`the accepted main is ${merged}; main moved forward`));
  assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
}));

// cli.md "vault sync": in forge mode an owner's open proposal is never merged with main locally, so
// the pull request keeps the commit the owner approves; an agent actor's branch is still merged.
test('sync leaves an owner\'s proposal as it stands in forge mode, and still merges main into an actor\'s branch', withForgeInstallation(async (t, forge) => {
  for (const actor of ['alice', 'gardener']) {
    assert.equal((await t.run('write', { path: `notes/${actor}.md`, content: actor, actor }, { surface: 'mcp' })).status, 'ok');
    assert.equal((await t.run('commit', { message: `A note by ${actor}`, actor })).status, 'ok');
  }
  assert.equal((await t.run('propose', { actor: 'alice' })).status, 'ok');
  const proposed = t.repo.git('rev-parse', 'refs/heads/actor/alice');
  mergeInForge(forge, { 'merged.md': 'merged in the forge' });
  const synced = await t.run('sync', {});
  assert.equal(synced.status, 'ok', synced.text);
  assert.match(synced.text, new RegExp(`alice: left as it is at ${proposed}`));
  assert.match(synced.text, /gardener: merged at /);
  assert.equal(t.repo.git('rev-parse', 'refs/heads/actor/alice'), proposed, 'the owner\'s branch is the commit proposed');
}));

// security-setup.md "Merging once approved": the forge is asked to merge a proposal itself once
// approved; where it refuses (the account may not merge) or cannot, propose says to merge by hand.
const proposeGardenerNote = async (t: Parameters<Parameters<typeof withForgeInstallation>[0]>[0]) => {
  assert.equal((await t.run('write', { path: 'notes/a.md', content: 'A', actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
  assert.equal((await t.run('commit', { message: 'A note', actor: 'gardener' })).status, 'ok');
  return t.run('propose', { actor: 'gardener' });
};

test('propose asks the forge to merge it once approved, pinned to the head proposed and with a merge commit', withForgeInstallation(async (t, forge) => {
  const proposed = await proposeGardenerNote(t);
  assert.equal(proposed.status, 'ok', proposed.text);
  const head = t.repo.git('rev-parse', 'refs/heads/actor/gardener');
  assert.deepEqual(forge.stub.model.scheduledMerges, [{ pull: 1, head, style: 'merge' }]);
  const again = await t.run('propose', { actor: 'gardener' });
  assert.match(again.text, /The forge merges it once it is approved/, 'already scheduled is fine');
}));

test('when the account may not merge, propose says to merge by hand and how to allow it', withForgeInstallation(async (t, forge) => {
  forge.stub.model.mergeForbidden = true;
  const proposed = await proposeGardenerNote(t);
  assert.equal(proposed.status, 'ok', 'the proposal itself stands');
  assert.match(proposed.text, /Merge it by hand once approved: .*may not merge\. Add it to the branch protection's merge allowlist/);
  assert.deepEqual(forge.stub.model.scheduledMerges, []);
}));

test('with auto-merge: false on the forge entry, nothing is scheduled and propose says to merge by hand', withForgeInstallation(async (t, forge) => {
  const proposed = await proposeGardenerNote(t);
  assert.match(proposed.text, /Merge it by hand once approved: this forge \(or its entry, auto-merge: false\)/);
  assert.deepEqual(forge.stub.model.scheduledMerges, []);
}, { autoMerge: false }));
