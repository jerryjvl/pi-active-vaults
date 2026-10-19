// Documented behaviour: concepts.md "Review modes" (backups) — a local-mode
// vault whose registration names a Git remote is pushed there: `main`, the
// actor branches and the package's notes. A backup never loses history:
// `main` and the notes go fast-forward only, so a diverged remote is reported
// and left alone, and nothing is pruned; actor branches are forced, being
// reset after an accept. A remote this clone lacks is reported with what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupVault } from '../../../src/core/backup/index.ts';
import { withTestVault, type TestVault } from '../../support/vault.ts';

/** A bare repository as the backup remote "backup", removed after `run`. */
async function withBackup(v: TestVault, run: (remote: (...args: string[]) => string) => Promise<void>): Promise<void> {
  const bare = mkdtempSync(join(tmpdir(), 'pav-backup-'));
  const remote = (...args: string[]): string => execFileSync('git', ['-C', bare, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  v.repo.git('remote', 'add', 'backup', bare);
  try {
    await run(remote);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

const refsOf = (remote: (...args: string[]) => string): string[] => remote('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort();

test('a remote this clone does not have is reported with what to do', withTestVault(async (v) => {
  const done = await backupVault(v.git, { ...v.vault, remote: 'backup' });
  assert.ok(!done.ok && done.error.reason === 'missing-remote');
  assert.match(done.error.notes, /Vault "home" is backed up to the Git remote "backup", which this clone does not have/);
  assert.match(done.error.notes, new RegExp(`git -C ${v.repo.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} remote add backup <its URL>`));
  assert.match(done.error.notes, /vault sync home/);
}));

test('main, the actor branches and the package\'s notes are pushed; nothing again until they change', withTestVault(async (v) => {
  v.propose({ 'notes/a.md': 'A' });
  v.repo.git('notes', '--ref=refs/notes/vault/traces', 'add', '-m', 'trace', 'HEAD');
  v.repo.git('branch', 'scratch-work');
  await withBackup(v, async (remote) => {
    const first = await backupVault(v.git, { ...v.vault, remote: 'backup' });
    assert.ok(first.ok && first.value.outcome === 'pushed', JSON.stringify(first));
    assert.deepEqual(refsOf(remote), ['refs/heads/actor/gardener', 'refs/heads/main', 'refs/notes/vault/traces'], 'not other branches');
    const again = await backupVault(v.git, { ...v.vault, remote: 'backup' }, first.value.state);
    assert.ok(again.ok && again.value.outcome === 'unchanged');
  });
}));

test('an actor branch reset after an accept is forced; one deleted here stays in the backup', withTestVault(async (v) => {
  v.propose({ 'notes/a.md': 'A' });
  await withBackup(v, async (remote) => {
    assert.ok((await backupVault(v.git, { ...v.vault, remote: 'backup' })).ok);
    v.repo.git('branch', '--force', 'actor/gardener', 'main');
    const forced = await backupVault(v.git, { ...v.vault, remote: 'backup' });
    assert.ok(forced.ok && forced.value.outcome === 'pushed', JSON.stringify(forced));
    assert.equal(remote('rev-parse', 'refs/heads/actor/gardener'), v.repo.git('rev-parse', 'main'));
    v.repo.git('branch', '--delete', '--force', 'actor/gardener');
    assert.ok((await backupVault(v.git, { ...v.vault, remote: 'backup' })).ok);
    assert.ok(refsOf(remote).includes('refs/heads/actor/gardener'), 'never pruned');
  });
}));

test('a backup whose main has diverged is reported and left as it is', withTestVault(async (v) => {
  await withBackup(v, async (remote) => {
    assert.ok((await backupVault(v.git, { ...v.vault, remote: 'backup' })).ok);
    const pushedMain = remote('rev-parse', 'refs/heads/main');
    v.repo.git('commit', '--quiet', '--amend', '-m', 'Rewritten history');
    const refused = await backupVault(v.git, { ...v.vault, remote: 'backup' });
    assert.ok(!refused.ok && refused.error.reason === 'push-refused', JSON.stringify(refused));
    assert.equal(remote('rev-parse', 'refs/heads/main'), pushedMain, 'the backup keeps what it had');
  });
}));
