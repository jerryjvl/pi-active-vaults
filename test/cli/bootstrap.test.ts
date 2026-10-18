// Documented behaviour: cli.md "Vaults and installation" — on a machine with no
// config file, `vault init` and `vault add` create it (a private directory and
// file) with `installation.person` from `--person`, by default the OS user's
// name, and register the vault; `vault init` installs the vault's Git hooks
// itself, and `vault add` does where none of the user's own are in the way and
// says so where one is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRepo } from '../support/git-repo.ts';
import { withEmptyHome, type EmptyHome } from '../support/empty-home.ts';
import { rootContract } from '../support/vault.ts';

const posix = process.platform === 'win32' ? { skip: 'POSIX file modes' } : {};

/** A vault made elsewhere, to add: its root contract committed on main. */
function otherVault(id: string): { path: string; cleanup(): void } {
  const repo = createTempRepo();
  repo.write('_contract.md', rootContract({ id, owners: ['jerry'] }));
  repo.commit('Create vault');
  return repo;
}

async function personIn(home: EmptyHome): Promise<string | undefined> {
  const who = await home.vault('whoami', '--json');
  assert.equal(who.code, 0, who.stderr);
  return (JSON.parse(who.stdout) as { data: { person?: string } }).data.person;
}

test('init on a machine with no config creates it, private, with the OS user as the person, and registers the vault', posix, withEmptyHome(async (home) => {
  assert.equal(existsSync(home.configFile), false);
  const made = await home.vault('init', home.dir.file('vaults', 'notes'));
  assert.equal(made.code, 0, made.stderr);
  assert.equal(readFileSync(home.configFile, 'utf8').includes('person: alice'), true, 'the OS user name');
  assert.equal(statSync(home.configFile).mode & 0o777, 0o600);
  assert.equal(statSync(home.dir.file('config')).mode & 0o777, 0o700);
  assert.equal(await personIn(home), 'alice');
  const listed = JSON.parse((await home.vault('list', '--json')).stdout) as { data: { vaults: { id: string; owners: string[] }[] } };
  assert.deepEqual(listed.data.vaults.map((v) => [v.id, v.owners]), [['notes', ['alice']]]);
  const doctor = await home.vault('doctor');
  assert.doesNotMatch(doctor.stdout, /no config file/);
}));

test('--person names the person, in the config and as the new vault\'s owner', withEmptyHome(async (home) => {
  const made = await home.vault('init', home.dir.file('vaults', 'notes'), '--person', 'jerry');
  assert.equal(made.code, 0, made.stderr);
  assert.equal(await personIn(home), 'jerry');
  const listed = JSON.parse((await home.vault('list', '--json')).stdout) as { data: { vaults: { owners: string[] }[] } };
  assert.deepEqual(listed.data.vaults[0]?.owners, ['jerry']);
}));

test('add on a machine with no config creates it the same way, and registers the vault it is given', posix, withEmptyHome(async (home) => {
  const other = otherVault('garden');
  try {
    const added = await home.vault('add', other.path, '--person', 'jerry');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(await personIn(home), 'jerry');
    assert.equal(statSync(home.configFile).mode & 0o777, 0o600);
    assert.match((await home.vault('list')).stdout, /^garden /);
    const bare = await home.vault('whoami');
    assert.equal(bare.code, 0);
  } finally {
    other.cleanup();
  }
}));

test('a person that cannot be one is refused before anything is made, naming --person', withEmptyHome(async (home) => {
  const target = home.dir.file('vaults', 'notes');
  const refused = await home.vault('init', target, '--person', 'Jerry van Leeuwen');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--person/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(home.configFile), false);

  const spaced = await home.vaultWith({ io: { host: { ...home.host, user: 'Jerry van Leeuwen' } } })('init', home.dir.file('vaults', 'other'));
  assert.equal(spaced.code, 1, 'the default is the OS user, whose name has spaces');
  assert.match(spaced.stderr, /--person/);
  assert.equal(existsSync(home.configFile), false);
}));

test('--person is for creating the config: where it exists, it is refused rather than ignored', withEmptyHome(async (home) => {
  assert.equal((await home.vault('init', home.dir.file('vaults', 'one'))).code, 0);
  const again = await home.vault('init', home.dir.file('vaults', 'two'), '--person', 'someone');
  assert.equal(again.code, 1);
  assert.match(again.stderr, /installation\.person/);
  assert.equal(existsSync(home.dir.file('vaults', 'two')), false);
  assert.equal(await personIn(home), 'alice');
}));

test('a config that exists without a person is not rewritten: init still says an owner act needs one', withEmptyHome(async (home) => {
  mkdirSync(home.dir.file('config'), { recursive: true });
  writeFileSync(home.configFile, 'vaults: []\n');
  const refused = await home.vault('init', home.dir.file('vaults', 'one'));
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /installation\.person/);
  assert.equal(readFileSync(home.configFile, 'utf8'), 'vaults: []\n');
}));

test('init installs the vault\'s hooks itself: the pre-push guard and the refs hook', posix, withEmptyHome(async (home) => {
  const target = home.dir.file('vaults', 'notes');
  const made = await home.vault('init', target);
  assert.equal(made.code, 0, made.stderr);
  for (const [name, mark] of [['pre-push', 'pre-push guard'], ['reference-transaction', 'refs hook']] as const) {
    const hook = join(target, '.git', 'hooks', name);
    assert.match(readFileSync(hook, 'utf8'), new RegExp(mark));
    assert.equal(statSync(hook).mode & 0o111, 0o111, `${name} is executable`);
  }
  assert.match(made.stdout, /hooks/i);
  const doctor = await home.vault('doctor');
  assert.match(doctor.stdout, /ok +hooks \[notes\]: The pre-push guard is installed/);
  assert.doesNotMatch(doctor.stdout, /warning hooks/);
}));

test('add installs the hooks where none of the user\'s are in the way, and says which it left', posix, withEmptyHome(async (home) => {
  const other = otherVault('garden');
  try {
    const own = join(other.path, '.git', 'hooks', 'pre-push');
    writeFileSync(own, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const added = await home.vault('add', other.path, '--person', 'jerry');
    assert.equal(added.code, 0, added.stderr);
    assert.equal(readFileSync(own, 'utf8'), '#!/bin/sh\necho mine\n', 'the user\'s own hook is left alone');
    assert.match(readFileSync(join(other.path, '.git', 'hooks', 'reference-transaction'), 'utf8'), /refs hook/);
    assert.match(added.stdout, /pre-push hook of its own/);
    assert.match(added.stdout, /refs hook was installed/);
  } finally {
    other.cleanup();
  }
}));
