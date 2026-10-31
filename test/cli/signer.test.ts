// Documented behaviour: cli.md "Signer" — `vault signer key <file>` makes a
// new signing key in a new file readable by the user alone and prints its
// public key, never writing over a file; `vault signer status` says whether
// the signer answers; `vault signer run` does not start without its section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { signingKeyFrom } from '../../src/core/signing/index.ts';
import { cliFor } from '../support/cli.ts';
import { withInstallation } from '../support/installation.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'file modes' : false };

test('signer key writes a new private key the user alone can read, and prints its public key', posixOnly, withInstallation(async (t) => {
  const vault = cliFor(t);
  const file = t.dir.file('signing-key.pem');
  const made = await vault('signer', 'key', file);
  assert.equal(made.code, 0, made.stderr);
  const jwk = JSON.parse(made.stdout);
  const key = signingKeyFrom(readFileSync(file, 'utf8'));
  assert.ok(key.ok);
  assert.deepEqual(jwk, key.value.jwk, 'the printed key is the file\'s public key');
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.match(made.stderr, /key: "!cat .*signing-key\.pem"/);
  assert.ok(!made.stdout.includes('PRIVATE'), 'only the public key is printed');

  const again = await vault('signer', 'key', file);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists; a key is never written over/);
  writeFileSync(t.dir.file('other.pem'), 'kept');
  assert.equal((await vault('signer', 'key', t.dir.file('other.pem'))).code, 1);
  assert.equal(readFileSync(t.dir.file('other.pem'), 'utf8'), 'kept');
}));

test('signer status says when no signer answers; run does not start without a signer section; anything else is a usage error', withInstallation(async (t) => {
  const vault = cliFor(t);
  const status = await vault('signer', 'status');
  assert.equal(status.code, 1);
  assert.match(status.stderr, /No signer answers at .*signer\.sock/);
  const run = await vault('signer', 'run');
  assert.equal(run.code, 1);
  assert.match(run.stderr, /it cannot start \(the config has no signer section\)/);
  assert.equal((await vault('signer', 'sign')).code, 2);
  assert.equal((await vault('signer', 'key')).code, 2);
}));
