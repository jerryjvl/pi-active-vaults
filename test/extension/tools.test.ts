// Documented behaviour: api.md "Tools" and "Tool contract", pi-conventions.md
// "Tools" — tools are generated from the catalogue as `vault_<operation>`,
// with `vault_fan_out` the one Pi-only tool; exposure as documented; TypeBox
// parameters, each described, taking vault paths as `<vault-id>:<path>`;
// prompt snippets and guidelines that name the tool; text for the model and
// structured content for programs; failures with information are errors the
// model can act on; descriptions contain no runtime values. extension.md
// "Commits" — the commit tool runs the checks and commits with the session's
// trailers. extension.md "Unaccepted changes" — vault tool results carry the
// notice. Tested through Pi 1.3.0's SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withInstallation, type TestInstallation } from '../support/installation.ts';
import { DONE, toolResults, toolCall, withPi } from '../support/pi.ts';
import { RUNNING } from '../support/session.ts';


function vaultTools(pi: Awaited<Parameters<Parameters<typeof withPi>[2]>[0]>) {
  return pi.runtime.session.getAllTools().filter((tool) => tool.name.startsWith('vault_'));
}

test('the tools are the catalogue\'s, as vault_<operation>, plus vault_fan_out, with their documented exposure', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    const exposure = Object.fromEntries(vaultTools(pi).map((tool) => [tool.name, tool.exposure]));
    assert.deepEqual(exposure, {
      vault_search: 'direct', vault_read: 'direct', vault_contract: 'codemode', vault_jobs: 'codemode',
      vault_commit: 'direct', vault_script: 'direct', vault_fan_out: 'direct',
    });
  });
}, { running: RUNNING }));

test('every parameter is described, no tool lets the model choose whom it writes as, and the guidelines name the tool', withInstallation(async (t) => {
  await withPi(t, {}, async (pi) => {
    for (const tool of vaultTools(pi)) {
      const properties = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
      for (const [name, schema] of Object.entries(properties)) assert.ok((schema.description ?? '').length > 0, `${tool.name}.${name}`);
      assert.equal('actor' in properties, false, tool.name);
      assert.ok((tool.promptGuidelines ?? []).length > 0 && (tool.promptGuidelines ?? []).every((g) => g.includes(tool.name)), tool.name);
    }
    const search = vaultTools(pi).find((tool) => tool.name === 'vault_search');
    assert.deepEqual(Object.keys((search?.parameters as { properties: object }).properties).sort(), ['limit', 'query', 'scope', 'vaults']);
  });
}, { running: RUNNING }));

test('tool declarations are the same in every session: nothing computed at runtime', withInstallation(async (t) => {
  const declared = async (): Promise<string> => {
    let text = '';
    await withPi(t, {}, async (pi) => { text = JSON.stringify(vaultTools(pi).map((x) => [x.name, x.description, x.parameters, x.promptGuidelines])); });
    return text;
  };
  const first = await declared();
  t.repo.write('notes/a.md', 'changes nothing about the tools');
  t.repo.commit('more');
  t.accept();
  assert.equal(await declared(), first);
}, { running: RUNNING }));

test('vault_read returns the accepted content as text and as data; a missing document is an error the model can act on', withInstallation(async (t) => {
  t.repo.write('notes/a.md', 'Alpha.\n');
  t.repo.commit('note');
  t.accept();
  await withPi(t, {}, async (pi) => {
    pi.respond(toolCall('vault_read', { path: 'home:notes/a.md' }), toolCall('vault_read', { path: 'home:notes/missing.md' }), DONE);
    await pi.prompt('Read it.');
    assert.deepEqual(pi.results.map((r) => [r.tool, r.isError, r.text.split('\n')[0]]), [
      ['vault_read', false, 'Alpha.'],
      ['vault_read', true, 'home:notes/missing.md was not found.'],
    ]);
    const structured = pi.results[0]?.structured as { status: string; data: { freshness: string; content: string } };
    assert.deepEqual([structured.status, structured.data.freshness, structured.data.content], ['ok', 'current', 'Alpha.\n']);
    assert.match(toolResults(pi.requests.at(-1), 'vault_read')[0] ?? '', /^Alpha\./, 'the model sees the text');
  });
}, { running: RUNNING }));

test('a vault tool\'s result for a vault with an unaccepted change carries the notice', withInstallation(async (t) => {
  t.repo.write('notes/a.md', 'Alpha.\n');
  t.repo.commit('note');
  t.accept();
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  await withPi(t, {}, async (pi) => {
    pi.respond(toolCall('vault_read', { path: 'home:notes/a.md' }), DONE);
    await pi.prompt('Read it.');
    assert.match(toolResults(pi.requests.at(-1), 'vault_read')[0] ?? '', /Alpha\.[^]*Vault "home": main has 1 unaccepted commit/);
  });
}, { running: RUNNING }));

async function writeInWorktree(t: TestInstallation, actor: string, path: string, content: string): Promise<void> {
  writeFileSync(join(t.vault.worktrees, actor, ...path.split('/')), content);
}

test('vault_commit commits the session\'s worktree as its actor, with its trace and session, after the checks', withInstallation(async (t) => {
  await withPi(t, { flags: { 'vault-actor': 'gardener' } }, async (pi) => {
    await writeInWorktree(t, 'gardener', 'notes.md', 'A note.\n');
    pi.respond(toolCall('vault_commit', { message: 'Add a note' }), DONE);
    await pi.prompt('Commit.');
    const result = toolResults(pi.requests.at(-1), 'vault_commit')[0] ?? '';
    assert.match(result, /^Committed [0-9a-f]{40} on actor\/gardener\./);
    const message = t.repo.git('log', '-1', '--format=%B', 'refs/heads/actor/gardener');
    assert.match(message, /Vault-Trace: [0-9A-Z]{26}/);
    assert.match(message, /Vault-Actor: gardener/);
    assert.match(message, new RegExp(`Vault-Session: ${pi.runtime.session.sessionId}`));
    assert.doesNotMatch(message, /Vault-Tainted/);
  });
}, { running: RUNNING }));

test('a tool called under code mode\'s or the function-calling prefix reaches the tool it means', withInstallation(async (t) => {
  writeFileSync(join(t.repo.path, 'notes.md'), '# A note\n');
  t.accept(t.repo.commit('a note'));
  await withPi(t, {}, async (pi) => {
    pi.respond(toolCall('tools.vault_read', { path: 'home:notes.md' }), toolCall('functions.read', { path: 'notes.md' }), DONE);
    await pi.prompt('Read the note twice.');
    const last = pi.requests.at(-1);
    assert.match(toolResults(last, 'vault_read')[0] ?? '', /A note/);
    assert.match(toolResults(last, 'read')[0] ?? '', /A note/);
    assert.equal(pi.results.some((r) => r.isError), false);
  });
}, { running: RUNNING }));
