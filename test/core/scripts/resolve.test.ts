// Documented behaviour: concepts.md "Script" and security.md — vault scripts
// and checks are resolved only from the accepted `main`, never from a working
// tree, a branch or an unaccepted commit; built-ins live under `builtin:` and
// a vault script named like one is an error, not an override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listScripts, resolveScript, type BuiltinScript } from '../../../src/core/scripts/index.ts';
import { scriptSource as script, withTestVault } from '../../support/vault.ts';

const notify: BuiltinScript = {
  name: 'notify',
  header: { summary: 'Send a notification', args: '--to <alias> --subject <text>', net: true },
  run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
};

test('a script resolves to its version on the accepted main, not the working tree, main\'s tip or a branch', withTestVault(async ({ repo, git, vault, accept }) => {
  repo.write('.vault/scripts/due.sh', script('due', 'echo accepted'));
  const acceptedSha = repo.commit('scripts');
  const accepted = accept();
  const acceptedBlob = repo.git('rev-parse', `${acceptedSha}:.vault/scripts/due.sh`);
  repo.write('.vault/scripts/due.sh', script('due', 'echo unaccepted'));
  repo.commit('unaccepted change to the script');
  repo.git('checkout', '--quiet', '-b', 'actor/gardener');
  repo.write('.vault/scripts/due.sh', script('due', 'echo branch'));
  repo.write('.vault/scripts/branch-only.sh', script('branch-only'));
  repo.commit('branch versions');
  repo.write('.vault/scripts/due.sh', script('due', 'echo working tree'));

  const resolved = await resolveScript(git, vault.path, accepted, 'due', { kind: 'script', builtins: [] });
  assert.ok(resolved.ok && resolved.value.source === 'vault');
  assert.equal(resolved.value.version, acceptedBlob);
  assert.equal(resolved.value.path, '.vault/scripts/due.sh');
  const missing = await resolveScript(git, vault.path, accepted, 'branch-only', { kind: 'script', builtins: [] });
  assert.equal(!missing.ok && missing.error.reason, 'no-such-script');
}));

test('built-ins resolve under builtin:, and a vault script named like one is an error, never an override', withTestVault(async ({ repo, git, vault, accept }) => {
  repo.write('.vault/scripts/notify.sh', script('notify'));
  repo.commit('a shadowing script');
  const accepted = accept();
  const options = { kind: 'script' as const, builtins: [notify] };
  const builtin = await resolveScript(git, vault.path, accepted, 'builtin:notify', options);
  assert.ok(builtin.ok && builtin.value.source === 'builtin' && builtin.value.builtin === notify);
  const shadow = await resolveScript(git, vault.path, accepted, 'notify', options);
  assert.equal(!shadow.ok && shadow.error.reason, 'shadows-builtin');
  const unknown = await resolveScript(git, vault.path, accepted, 'builtin:nope', options);
  assert.equal(!unknown.ok && unknown.error.reason, 'no-such-script');
  const listed = await listScripts(git, vault.path, accepted, options);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.invalid.map((i) => [i.name, i.issues[0]?.message]), [['notify', 'shadows the built-in builtin:notify']]);
}));

test('only files directly in the directory are scripts; subdirectories and hidden files hold support files', withTestVault(async ({ repo, git, vault, accept }) => {
  repo.write('.vault/scripts/due.sh', script('due'));
  repo.write('.vault/scripts/lib/util.sh', 'helper');
  repo.write('.vault/scripts/.gitkeep', '');
  repo.commit('scripts');
  const accepted = accept();
  const listed = await listScripts(git, vault.path, accepted, { kind: 'script', builtins: [] });
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.scripts.map((s) => s.name), ['due']);
  assert.deepEqual(listed.value.invalid, []);
  const support = await resolveScript(git, vault.path, accepted, 'lib/util', { kind: 'script', builtins: [] });
  assert.equal(!support.ok && support.error.reason, 'no-such-script');
}));

test('checks are resolved from .vault/checks with the version that attests them', withTestVault(async ({ repo, git, vault, accept }) => {
  repo.write('.vault/checks/links.sh', script('links'));
  repo.write('.vault/scripts/due.sh', script('due'));
  const sha = repo.commit('check');
  const accepted = accept();
  const listed = await listScripts(git, vault.path, accepted, { kind: 'check', builtins: [] });
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.scripts.map((s) => [s.kind, s.name, s.version]), [
    ['check', 'links', repo.git('rev-parse', `${sha}:.vault/checks/links.sh`)],
  ]);
  const notACheck = await resolveScript(git, vault.path, accepted, 'due', { kind: 'check', builtins: [] });
  assert.equal(!notACheck.ok && notACheck.error.reason, 'no-such-script');
}));

test('an invalid header, two files of one name, or a symbolic link make a script unusable, and are listed as such', withTestVault(async ({ repo, git, vault, accept }) => {
  repo.write('.vault/scripts/bad.sh', '#!/bin/sh\n# summary: no name\n');
  repo.write('.vault/scripts/twice.sh', script('twice'));
  repo.write('.vault/scripts/twice.py', script('twice'));
  repo.commit('odd scripts');
  // A symbolic link committed through the index, so the test needs no link support from the file system.
  repo.write('link-target', '/etc/passwd');
  const target = repo.git('hash-object', '-w', 'link-target');
  repo.git('update-index', '--add', '--cacheinfo', `120000,${target},.vault/scripts/link.sh`);
  repo.git('commit', '--quiet', '-m', 'symlink');
  const accepted = accept();
  const options = { kind: 'script' as const, builtins: [] };
  for (const [name, reason] of [['bad', 'invalid-script'], ['twice', 'ambiguous-script'], ['link', 'invalid-script']] as const) {
    const resolved = await resolveScript(git, vault.path, accepted, name, options);
    assert.equal(!resolved.ok && resolved.error.reason, reason, name);
  }
  const listed = await listScripts(git, vault.path, accepted, options);
  assert.ok(listed.ok);
  assert.deepEqual(listed.value.scripts, []);
  assert.deepEqual(listed.value.invalid.map((i) => i.name), ['bad', 'link', 'twice']);
}));
