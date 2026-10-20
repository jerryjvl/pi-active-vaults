// Documented behaviour: notices and errors that ask a person to resolve
// something by hand give the commands with the directory they are for
// (daemon.md "Integrity", cli.md "vault sync", "vault commit").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWord, stepsIn, withoutSteps } from '../../../src/core/git/index.ts';

test('steps start with the cd to their directory, one command per indented line', () => {
  assert.equal(stepsIn('/home/a/vault', ['git status', 'git add a.md']), '  cd /home/a/vault\n  git status\n  git add a.md');
});

test('a path the shell would split or expand is quoted; a plain one is not', () => {
  assert.equal(shellWord('/tmp/plain-dir_1/x.md'), '/tmp/plain-dir_1/x.md');
  assert.equal(shellWord('/mnt/c/My Files'), "'/mnt/c/My Files'");
  assert.equal(shellWord("it's $HOME"), `'it'\\''s $HOME'`);
  assert.equal(shellWord('C:\\vaults\\home'), 'C:\\vaults\\home', 'a plain Windows path');
  assert.equal(shellWord('C:\\My Vaults\\home'), '"C:\\My Vaults\\home"', 'a Windows path is double-quoted');
});

test("for a remote client, each block of steps is replaced by a pointer to the vault's machine; the rest stays", () => {
  const text = ['Something to resolve:', stepsIn('/home/a/vault', ['git status']), 'Or else:', '  ' + stepsIn('/w', ['git x']).replaceAll('\n', '\n  '), 'Done.'].join('\n');
  const remote = withoutSteps(text);
  assert.ok(!remote.includes('/home/a/vault') && !remote.includes('git status') && !remote.includes('/w'), remote);
  assert.equal(remote.split('\n').filter((l) => l.includes("on the vault's own machine")).length, 2, remote);
  assert.ok(remote.startsWith('Something to resolve:\n') && remote.endsWith('\nDone.'), remote);
});
