// Documented behaviour: cli.md "Vaults and installation" — `vault workspace`
// writes an editor workspace with the installation person's worktree in every
// vault they own or write as, one folder each, named by vault id, making any
// worktree that is missing; a vault with nothing accepted yet, or one the
// person has no part in, is left out and said so. `--open` opens it with
// `code`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withInstallation } from '../../support/installation.ts';

interface Workspace { folders: { name: string; path: string }[] }

test('workspace lists the person\'s worktree in each vault, making it if missing', withInstallation(async (t) => {
  const done = await t.run('workspace');
  assert.equal(done.status, 'ok', done.text);
  const file = t.installation.paths.workspace;
  const workspace = JSON.parse(readFileSync(file, 'utf8')) as Workspace;
  const mine = join(t.vault.worktrees, 'alice');
  assert.deepEqual(workspace.folders, [{ name: 'home', path: mine }]);
  assert.equal(existsSync(join(mine, '_contract.md')), true, 'the worktree was made');
  assert.match(done.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}));

test('vaults the person has no part in, or with nothing accepted, are left out and said so', withInstallation(async (t) => {
  const done = await t.run('workspace');
  assert.equal(done.status, 'ok', done.text);
  const workspace = JSON.parse(readFileSync(t.installation.paths.workspace, 'utf8')) as Workspace;
  assert.deepEqual(workspace.folders.map((f) => f.name), ['home']);
  assert.match(done.text, /garden: left out \(alice is not one of its owners or actors\)/);
}, { others: [{ id: 'garden', contract: { owners: ['bob'], actors: ['gardener'] } }] }));

test('--open opens the workspace with `code`', { skip: process.platform === 'win32' ? 'POSIX shell script' : false }, async () => {
  const bin = binWithCode();
  try {
  await withInstallation(async (t) => {
    const done = await t.run('workspace', { open: true });
    assert.equal(done.status, 'ok', done.text);
    assert.equal(readFileSync(join(bin, 'opened'), 'utf8').trim(), t.installation.paths.workspace);
  }, {
    env: { PATH: `${bin}:/usr/bin:/bin` },
  })();
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

/** A directory holding a fake `code` that records what it was asked to open. */
function binWithCode(): string {
  const dir = join(process.env['TMPDIR'] ?? '/tmp', `pav-code-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'code'), `#!/bin/sh\nprintf '%s\\n' "$1" > "${dir}/opened"\n`);
  chmodSync(join(dir, 'code'), 0o755);
  return dir;
}
