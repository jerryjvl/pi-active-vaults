// Documented behaviour: mcp.md "Permissions" and "Profiles and layering" — a
// permission is an operation's name, and a profile's permissions are a plain
// set: no permission implies another. Groups are shorthand for sets. Each
// vault's set is the profile's base set (empty unless given), replaced or
// edited by the vault's entry with the contract list syntax. With no `mcp`
// section, or a profile without permissions, nothing is permitted. `accept`
// needs a profile with an `owner`. The section is validated strictly when the
// config loads, without repeating values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSIONS, PERMISSION_GROUPS, effectivePermissions, mayCall, parseMcpConfig, permittedOperations, type McpConfig, type Permission,
} from '../../../src/core/operations/index.ts';

const VAULTS = ['home', 'private', 'work'];

function parsed(value: unknown): McpConfig {
  const result = parseMcpConfig(value, VAULTS);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.error));
  return result.value;
}

function issues(value: unknown): string[] {
  const result = parseMcpConfig(value, VAULTS);
  assert.ok(!result.ok, 'expected the section to be refused');
  return result.error.map((i) => `${i.path}: ${i.message}`);
}

const profile = (fields: Record<string, unknown>) => ({ profiles: [{ name: 'p', listen: '127.0.0.1:8735', token: '${MCP_TOKEN}', ...fields }] });
const sorted = (set: ReadonlySet<Permission>): Permission[] => [...set].sort();

test('the permissions are the documented operations, and the groups expand to the documented sets', () => {
  assert.deepEqual([...PERMISSIONS], ['search', 'read', 'contract', 'jobs', 'status', 'trace', 'write', 'commit', 'propose', 'run', 'trigger', 'script', 'notify', 'review', 'accept', 'reindex']);
  assert.deepEqual(PERMISSION_GROUPS, {
    '@read': ['search', 'read', 'contract', 'jobs', 'status', 'trace'],
    '@propose': ['write', 'commit', 'propose'],
    '@run': ['run', 'trigger', 'script', 'notify'],
    '@admin': ['review', 'accept', 'reindex'],
  });
});

test('with no mcp section, or a profile with no permissions, nothing is permitted anywhere', () => {
  assert.deepEqual(parsed(undefined), { profiles: [] });
  const bare = parsed(profile({})).profiles[0];
  assert.ok(bare !== undefined);
  for (const vault of VAULTS) assert.deepEqual(sorted(effectivePermissions(bare, vault)), []);
  assert.deepEqual(permittedOperations(bare), []);
});

test('the base set applies to every vault; groups and names mix; no permission implies another', () => {
  const p = parsed(profile({ permissions: ['@read', 'commit', 'accept'], owner: 'alice' })).profiles[0];
  assert.ok(p !== undefined);
  assert.deepEqual(sorted(effectivePermissions(p, 'home')), ['accept', 'commit', 'contract', 'jobs', 'read', 'search', 'status', 'trace']);
  assert.equal(mayCall(p, 'review', 'home'), false, 'accept does not imply review');
  assert.equal(mayCall(p, 'write', 'home'), false, 'commit does not imply write');
  assert.equal(mayCall(p, 'propose', 'home'), false);
  assert.equal(mayCall(p, 'read', 'unregistered'), false, 'a vault the installation does not have');
});

test('a vault\'s entry replaces the base set with a plain list, or edits it with + and -', () => {
  const p = parsed(profile({
    permissions: ['@read', '@propose'],
    vaults: { private: [], home: ['+review', '-propose'], work: ['search', 'read'] },
  })).profiles[0];
  assert.ok(p !== undefined);
  assert.deepEqual(sorted(effectivePermissions(p, 'private')), [], 'nothing at all for this vault');
  assert.deepEqual(sorted(effectivePermissions(p, 'home')), ['commit', 'contract', 'jobs', 'read', 'review', 'search', 'status', 'trace', 'write']);
  assert.deepEqual(sorted(effectivePermissions(p, 'work')), ['read', 'search']);
  const groups = parsed(profile({ permissions: ['@read'], vaults: { home: ['+@run', '-@read', '+read'] } })).profiles[0];
  assert.ok(groups !== undefined);
  assert.deepEqual(sorted(effectivePermissions(groups, 'home')), ['notify', 'read', 'run', 'script', 'trigger']);
});

test('a client sees each operation permitted for at least one vault, in the catalogue\'s stable order; others are refused', () => {
  const p = parsed(profile({ permissions: ['trace', 'search'], vaults: { home: ['+commit'], work: ['read'] } })).profiles[0];
  assert.ok(p !== undefined);
  assert.deepEqual(permittedOperations(p), ['search', 'read', 'trace', 'commit']);
  assert.equal(mayCall(p, 'commit', 'home'), true);
  assert.equal(mayCall(p, 'commit', 'private'), false);
  assert.equal(mayCall(p, 'search', 'work'), false, 'the work entry replaced the base set');
});

test('accept is permitted only on a profile that declares an owner', () => {
  assert.deepEqual(issues(profile({ permissions: ['@admin'] })), ['mcp.profiles[0]: accept is permitted, so the profile must name an owner']);
  assert.deepEqual(issues(profile({ vaults: { home: ['+accept'] } })), ['mcp.profiles[0]: accept is permitted, so the profile must name an owner']);
  const owned = parsed(profile({ permissions: ['@admin'], owner: 'alice' })).profiles[0];
  assert.equal(owned?.owner, 'alice');
  assert.equal(owned !== undefined && mayCall(owned, 'accept', 'home'), true);
});

test('the section is checked strictly: unknown keys, operations, groups and vaults, mixed list edits, and secrets', () => {
  assert.deepEqual(issues({ profiles: [], extra: 1 }), ['mcp.extra: unknown key']);
  assert.deepEqual(issues(profile({ permissions: ['serch', '@everything'] })), [
    'mcp.profiles[0].permissions[0]: is not an operation or group',
    'mcp.profiles[0].permissions[1]: is not an operation or group',
  ]);
  assert.deepEqual(issues(profile({ vaults: { elsewhere: ['read'], home: ['read', '+search'], work: ['+nope'] } })), [
    'mcp.profiles[0].vaults.elsewhere: is not a registered vault',
    'mcp.profiles[0].vaults.home: cannot mix + and - edits with plain items',
    'mcp.profiles[0].vaults.work[0]: is not an operation or group',
  ]);
  const literal = issues(profile({ token: 'hunter2-literal' })).join('\n');
  assert.match(literal, /mcp\.profiles\[0\]\.token/);
  assert.ok(!literal.includes('hunter2'), 'issues never repeat the value');
  assert.deepEqual(issues({ profiles: [{ name: 'a', listen: '127.0.0.1:1' }, { name: 'a' }] }), [
    'mcp.profiles[0]: an HTTP endpoint needs a token',
    'mcp.profiles[1].name: another profile has this name',
  ]);
  assert.deepEqual(issues(profile({ listen: 'localhost' })), ['mcp.profiles[0].listen: must be host:port, or an absolute socket or pipe path']);
  assert.deepEqual(issues(profile({ unknown: true })), ['mcp.profiles[0].unknown: unknown key']);
});

test('an endpoint is a loopback address and port, a socket path, or none (standard input/output only)', () => {
  const config = parsed({ profiles: [
    { name: 'http', listen: '127.0.0.1:8735', token: '${T}' },
    { name: 'socket', listen: '/run/user/1000/pav-chat.sock' },
    { name: 'pipe', listen: '\\\\.\\pipe\\pav-chat' },
    { name: 'stdio' },
  ] });
  assert.deepEqual(config.profiles.map((p) => p.listen), [
    { kind: 'tcp', host: '127.0.0.1', port: 8735 },
    { kind: 'path', path: '/run/user/1000/pav-chat.sock' },
    { kind: 'path', path: '\\\\.\\pipe\\pav-chat' },
    undefined,
  ]);
  assert.deepEqual(config.profiles[0]?.token, { kind: 'env', name: 'T', where: 'mcp.profiles[0].token' });
});
