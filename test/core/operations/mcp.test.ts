// Documented behaviour: mcp.md — a client sees exactly the operations its
// profile permits for at least one vault, in a stable order, and nothing
// else is callable; a call for a vault where the operation is not permitted
// is refused (an unknown vault no differently, so a profile cannot learn of
// vaults it may not touch); an operation over many vaults covers the
// permitted ones. No permission implies another. `accept` needs an owner, and
// reviews and approvals through a profile are its owner's. `write` and
// `commit` name their actor — one of the vault's `actors`, never an owner —
// and are refused while another session holds it; every MCP commit carries
// `Vault-Tainted`. An operation behaves as on every surface, and every
// response for a vault with an unaccepted change carries the notice. A
// confirmation is the person's to give, so it is never offered over MCP.
// Each HTTP endpoint's bearer token must match exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeActorHold } from '../../../src/core/actors/index.ts';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import {
  PERMISSIONS, bearerMatches, callMcpTool, mcpTools, type McpProfile, type ModelResult, type Permission,
} from '../../../src/core/operations/index.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';

const OTHERS = { others: [{ id: 'private' }] } as const;

/** An installation whose config has these MCP profiles, each `{ name, permissions, vaults?, owner? }`. */
function withProfiles(profiles: readonly Record<string, unknown>[], run: (t: TestInstallation) => Promise<void>, options: { running?: Record<number, string> } = {}) {
  return withInstallation(run, { ...OTHERS, ...options, config: `mcp:\n  profiles: ${JSON.stringify(profiles)}` });
}

function profileOf(t: TestInstallation, name: string): McpProfile {
  const found = t.installation.mcp.profiles.find((p) => p.name === name);
  assert.ok(found !== undefined, name);
  return found;
}

const call = (t: TestInstallation, profile: string | McpProfile, tool: string, input: unknown = {}): Promise<ModelResult> =>
  callMcpTool(t.context, typeof profile === 'string' ? profileOf(t, profile) : profile, tool, input);

const statusOf = (result: ModelResult): string => result.structured.status;
const tool = (permission: Permission): string => `vault_${permission}`;

test('with no mcp section, or a profile with no permissions, a client sees nothing and can call nothing', withInstallation(async (t) => {
  assert.deepEqual(t.installation.mcp.profiles, []);
  const empty: McpProfile = { name: 'none', permissions: new Set(), vaults: new Map([['home', new Set()]]) };
  assert.deepEqual(mcpTools(empty), []);
  for (const permission of PERMISSIONS) {
    const result = await call(t, empty, tool(permission));
    assert.equal(statusOf(result), 'refused', permission);
    assert.match(result.text, /No tool/);
  }
}));

test('each permission alone lists exactly its own tool, and every other tool is neither listed nor callable', withProfiles(
  PERMISSIONS.map((p) => ({ name: p, permissions: [p], ...(p === 'accept' || p === 'review' ? { owner: 'alice' } : {}) })),
  async (t) => {
    for (const permission of PERMISSIONS) {
      const profile = profileOf(t, permission);
      assert.deepEqual(mcpTools(profile).map((x) => x.name), [tool(permission)], permission);
      for (const other of PERMISSIONS.filter((o) => o !== permission)) {
        const result = await call(t, profile, tool(other), { vault: 'home' });
        assert.equal(statusOf(result), 'refused', `${permission} calling ${other}`);
        assert.match(result.text, /No tool/, `${permission} calling ${other}`);
      }
    }
  },
));

test('operations that are no permission are never tools, whatever a profile permits', withProfiles([{ name: 'all', permissions: ['@read', '@propose', '@run', '@admin'], owner: 'alice' }], async (t) => {
  const tools = mcpTools(profileOf(t, 'all'));
  assert.deepEqual(tools.map((x) => x.name), PERMISSIONS.map(tool), 'every permission, in the catalogue\'s order');
  for (const name of ['vault_sync', 'vault_doctor', 'vault_init', 'vault_add', 'vault_list', 'vault_whoami', 'sync', 'search', '']) {
    assert.match((await call(t, 'all', name)).text, /No tool/, name);
  }
}));

test('a tool\'s schema is its operation\'s MCP parameters, with the vault to act on, and nothing from this machine', withProfiles([{ name: 'all', permissions: ['@read', '@propose', '@run', '@admin'], owner: 'alice' }], async (t) => {
  const tools = new Map(mcpTools(profileOf(t, 'all')).map((x) => [x.name, x]));
  const search = tools.get('vault_search');
  assert.deepEqual(search?.inputSchema['type'], 'object');
  assert.ok(Object.keys(search?.inputSchema['properties'] as object).includes('vaults'), 'an operation over many takes vaults');
  assert.deepEqual((search?.inputSchema['required'] as string[]), ['query']);
  const write = tools.get('vault_write')?.inputSchema;
  assert.deepEqual(Object.keys(write?.['properties'] as object).sort(), ['actor', 'content', 'path', 'vault']);
  assert.deepEqual((write?.['required'] as string[]).sort(), ['actor', 'content', 'path'], 'MCP writes name their actor');
  const accept = tools.get('vault_accept')?.inputSchema;
  assert.ok(!Object.keys(accept?.['properties'] as object).includes('yes'), 'a confirmation is never offered');
  const text = JSON.stringify([...tools.values()].map((x) => [x.description, x.inputSchema]));
  for (const local of [t.repo.path, t.dir.path, 'alice@homeserver']) assert.ok(!text.includes(local), local);
}));

test('a vault\'s entry removes or edits its permissions: a call there is refused like one for an unknown vault, and an operation over many leaves it out', withProfiles([
  { name: 'reader', permissions: ['@read'], vaults: { private: [] } },
  { name: 'edited', permissions: ['search'], vaults: { private: ['+read', '-search'] } },
], async (t) => {
  t.repo.write('notes/a.md', '# Home note\n');
  t.repo.commit('home note');
  t.accept();
  const theirs = t.others['private'];
  assert.ok(theirs !== undefined);
  theirs.repo.write('notes/secret.md', '# Secret\n');
  theirs.repo.commit('secret');
  const refusedHere = await call(t, 'reader', 'vault_read', { path: 'private:notes/secret.md' });
  const refusedNowhere = await call(t, 'reader', 'vault_read', { path: 'nowhere:notes/secret.md' });
  assert.equal(statusOf(refusedHere), 'refused');
  assert.equal(refusedHere.text.replace('private', 'X'), refusedNowhere.text.replace('nowhere', 'X'), 'a vault it may not touch is told apart from none');
  assert.ok(!refusedHere.text.includes('Secret'));
  assert.equal(statusOf(await call(t, 'reader', 'vault_status', { vaults: ['private'] })), 'refused');
  const status = await call(t, 'reader', 'vault_status');
  assert.equal(statusOf(status), 'ok', status.text);
  assert.ok(!status.text.includes('private'), 'every permitted vault, and only those');

  assert.equal(statusOf(await call(t, 'edited', 'vault_search', { query: 'note', vaults: ['private'] })), 'refused', '-search');
  assert.equal(statusOf(await call(t, 'edited', 'vault_read', { path: 'home:notes/a.md' })), 'refused', '+read is only for private');
  assert.deepEqual(mcpTools(profileOf(t, 'edited')).map((x) => x.name), ['vault_search', 'vault_read']);
}));

test('the vault is named as the operation\'s scope takes it: one by `vault` or a vault path, many by `vaults`; a vault is needed', withProfiles([{ name: 'p', permissions: ['@read', 'notify', 'jobs'] }], async (t) => {
  assert.equal(statusOf(await call(t, 'p', 'vault_contract', { path: 'notes', vaults: ['home'] })), 'invalid', 'one vault is `vault`');
  assert.equal(statusOf(await call(t, 'p', 'vault_status', { vault: 'home' })), 'invalid', 'many are `vaults`');
  assert.equal(statusOf(await call(t, 'p', 'vault_contract', { path: 'notes' })), 'invalid', 'which vault?');
  assert.equal(statusOf(await call(t, 'p', 'vault_contract', { path: 'notes', vault: 'home' })), 'ok');
  const notify = await call(t, 'p', 'vault_notify', { to: 'me', subject: 'x' });
  assert.equal(statusOf(notify), 'invalid', 'an operation that may act on no vault still names one over MCP, so its permission can be checked');
  assert.equal(statusOf(await call(t, 'p', 'vault_contract', 'not an object')), 'invalid');
}));

test('writes over MCP name one of the vault\'s actors: never an owner, never the profile\'s owner by default; a held actor is refused', withProfiles(
  [{ name: 'editor', permissions: ['@propose'], owner: 'alice' }],
  async (t) => {
    const write = (input: Record<string, unknown>) => call(t, 'editor', 'vault_write', { path: 'home:notes/a.md', content: '# A\n', ...input });
    assert.equal(statusOf(await write({})), 'invalid', 'the actor is required');
    for (const actor of ['alice', 'stranger']) {
      const refused = await write({ actor });
      assert.equal(statusOf(refused), 'refused', actor);
      assert.match(refused.text, /not one of vault "home"'s actors/, actor);
    }
    assert.equal(statusOf(await call(t, 'editor', 'vault_commit', { vault: 'home', message: 'x', actor: 'alice' })), 'refused', 'nor commit as an owner');

    const held = await takeActorHold(t.context.state, t.context.alive, t.clock, { vault: 'home', actor: 'gardener', holder: { session: 'pi-1', process: { pid: 4242, started: 'then' } } });
    assert.ok(held.ok);
    assert.equal(statusOf(await write({ actor: 'gardener' })), 'refused', 'held by another session');
  },
  { running: { 4242: 'then' } },
));

test('every commit through MCP is tainted, as the actor named, with the package\'s trailers', withProfiles([{ name: 'editor', permissions: ['@propose'] }], async (t) => {
  const written = await call(t, 'editor', 'vault_write', { path: 'home:notes/a.md', content: '# A\n', actor: 'gardener' });
  assert.equal(statusOf(written), 'ok', written.text);
  const committed = await call(t, 'editor', 'vault_commit', { vault: 'home', message: 'From a client', actor: 'gardener' });
  assert.equal(statusOf(committed), 'ok', committed.text);
  assert.match(t.repo.git('log', '-1', '--format=%B', 'actor/gardener'), /^From a client\n\nVault-Trace: [0-9A-Z]{26}\nVault-Actor: gardener\nVault-Tainted: yes$/);
}));

test('reviews and approvals through a profile are its owner\'s; accept is refused through a profile without one', withProfiles([
  { name: 'admin', permissions: ['@propose', 'review', 'accept', 'status'], owner: 'alice' },
], async (t) => {
  assert.equal(statusOf(await call(t, 'admin', 'vault_write', { path: 'home:notes/a.md', content: '# A\n', actor: 'gardener' })), 'ok');
  assert.equal(statusOf(await call(t, 'admin', 'vault_commit', { vault: 'home', message: 'A', actor: 'gardener' })), 'ok');
  const reviewed = await call(t, 'admin', 'vault_review', { vault: 'home', actor: 'gardener' });
  assert.match(reviewed.text, /Recorded as alice's review/);

  const ownerless: McpProfile = { ...profileOf(t, 'admin'), name: 'ownerless' };
  delete (ownerless as { owner?: string }).owner;
  assert.ok(!mcpTools(ownerless).some((x) => x.name === 'vault_accept'), 'not listed without an owner');
  assert.equal(statusOf(await call(t, ownerless, 'vault_accept', { vault: 'home', actor: 'gardener' })), 'refused');
  assert.equal(statusOf(await call(t, ownerless, 'vault_review', { vault: 'home', actor: 'gardener' })), 'refused', 'no person to review as');
}));

test('adopting main is never confirmed over MCP: the delta is shown, nothing is adopted', withProfiles([{ name: 'admin', permissions: ['accept'], owner: 'alice' }], async (t) => {
  t.repo.write('stray.md', 'x');
  const tip = t.repo.commit('stray');
  const shown = await call(t, 'admin', 'vault_accept', { vault: 'home', adopt: tip });
  assert.equal(statusOf(shown), 'refused');
  assert.equal(statusOf(await call(t, 'admin', 'vault_accept', { vault: 'home', adopt: tip, yes: true })), 'invalid', '`yes` is not an MCP parameter');
  assert.notEqual(acceptedMain(t.context.state, 'home')?.sha, tip);
}));

test('every response for a vault with an unaccepted change carries its notice', withProfiles([{ name: 'reader', permissions: ['@read'] }], async (t) => {
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  const result = await call(t, 'reader', 'vault_status', { vaults: ['home'] });
  assert.equal(result.structured.notices.length, 1);
  assert.match(result.text, /Vault "home": main has 1 unaccepted commit/);
  assert.ok(!result.text.includes(t.repo.path) && !JSON.stringify(result.structured).includes(t.repo.path), 'no machine path for a remote client');
}));

test('a bearer token matches only exactly; the scheme\'s name in any case, as HTTP has it', () => {
  assert.equal(bearerMatches('Bearer s3cret-token', 's3cret-token'), true);
  assert.equal(bearerMatches('bearer s3cret-token', 's3cret-token'), true);
  for (const header of [undefined, '', 'Bearer', 'Bearer ', 'Bearer  s3cret-token', 'Bearer s3cret-token ', 'Bearer s3cret-tokenX', 'Bearer s3cret', 'Basic s3cret-token', 's3cret-token']) {
    assert.equal(bearerMatches(header, 's3cret-token'), false, String(header));
  }
  assert.equal(bearerMatches('Bearer ', ''), false, 'an empty token matches nothing');
});
