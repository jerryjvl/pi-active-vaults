// Documented behaviour: concepts.md "Script" — a session's scratch directory
// is claimed once, when it opens, and never shared: claiming one that is
// already there is an error, and afterwards it is only looked up. A fan-out's
// workspace is always new, named by the package, with one directory per item,
// seeded from a script's directory by copying its regular files only; a
// worker may write in its own directory and nowhere else, never through a
// link, within the workspace's limits, and never a .json file that does not
// parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimScratch, newWorkspace, scratchFor, seedDir, workspaceWrite, WORKSPACE_LIMITS } from '../../../src/core/config/index.ts';
import { createTempDir } from '../../support/temp-dir.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'links and modes' : false };

test('a scratch directory is claimed once, private, and only looked up afterwards', () => {
  const temp = createTempDir();
  try {
    const paths = { scratch: temp.file('scratch') };
    assert.equal(scratchFor(paths, 'T1'), undefined, 'never made by looking');
    const claimed = claimScratch(paths, 'T1');
    assert.ok(claimed.ok);
    assert.equal(scratchFor(paths, 'T1'), claimed.value);
    if (process.platform !== 'win32') assert.equal(statSync(claimed.value).mode & 0o777, 0o700);
    const again = claimScratch(paths, 'T1');
    assert.ok(!again.ok);
    assert.match(again.error, /already exists/);
  } finally {
    temp.cleanup();
  }
});

test('a workspace is new each time, one directory per item, seeded with regular files only; the seed is left as it was', posixOnly, () => {
  const temp = createTempDir();
  try {
    const scratch = temp.path;
    mkdirSync(join(scratch, 'seed', '1', 'notes'), { recursive: true });
    writeFileSync(join(scratch, 'seed', '1', 'facts.md'), '# Facts');
    writeFileSync(join(scratch, 'seed', '1', 'notes', 'a.txt'), 'a');
    writeFileSync(temp.file('secret'), 'outside');
    symlinkSync(temp.file('secret'), join(scratch, 'seed', '1', 'link.md'));
    const seed = seedDir(scratch, 'scratch:seed');
    assert.equal(seed, join(scratch, 'seed'));
    const made = newWorkspace(scratch, 'ID1', 2, seed);
    assert.ok(made.ok, !made.ok ? made.error : '');
    assert.equal(made.value.name, 'fanout-ID1');
    assert.deepEqual(made.value.dirs, [join(scratch, 'fanout-ID1', '1'), join(scratch, 'fanout-ID1', '2')]);
    assert.equal(readFileSync(join(made.value.dirs[0] ?? '', 'facts.md'), 'utf8'), '# Facts');
    assert.equal(readFileSync(join(made.value.dirs[0] ?? '', 'notes', 'a.txt'), 'utf8'), 'a');
    assert.equal(existsSync(join(made.value.dirs[0] ?? '', 'link.md')), false, 'a link is not copied');
    assert.ok(lstatSync(join(scratch, 'seed', '1', 'link.md')).isSymbolicLink(), 'the seed is untouched');
    const twice = newWorkspace(scratch, 'ID1', 1);
    assert.ok(!twice.ok, 'an ID already used is never shared');
    assert.equal(seedDir(scratch, 'scratch:../seed'), undefined);
    assert.equal(seedDir(scratch, 'scratch:missing'), undefined);
  } finally {
    temp.cleanup();
  }
});

test('a worker writes in its own directory only, never through a link, within the limits, and never JSON that does not parse', posixOnly, () => {
  const temp = createTempDir();
  try {
    const made = newWorkspace(temp.path, 'ID2', 2);
    assert.ok(made.ok);
    const [mine, theirs] = made.value.dirs as [string, string];
    assert.ok(workspaceWrite(mine, join(mine, 'items.json'), '{"items": []}').ok);
    assert.ok(workspaceWrite(mine, join(mine, 'deeper', 'facts.md'), '# Facts').ok);
    const json = workspaceWrite(mine, join(mine, 'items.json'), '{"items": [}');
    assert.ok(!json.ok);
    assert.match(json.error, /would not be valid JSON[^]*write it again/);
    assert.match((workspaceWrite(mine, join(theirs, 'x.md'), 'x') as { error: string }).error, /outside your workspace/, 'not another item\'s directory');
    assert.match((workspaceWrite(mine, join(mine, '..', '..', 'x.md'), 'x') as { error: string }).error, /outside your workspace/);
    symlinkSync(temp.path, join(mine, 'out'));
    assert.match((workspaceWrite(mine, join(mine, 'out', 'x.md'), 'x') as { error: string }).error, /outside your workspace/, 'a link that leads out');
    writeFileSync(join(mine, 'target.md'), 't');
    symlinkSync(join(mine, 'target.md'), join(mine, 'alias.md'));
    assert.match((workspaceWrite(mine, join(mine, 'alias.md'), 'x') as { error: string }).error, /is a link/);
    assert.match((workspaceWrite(mine, join(mine, 'big.md'), 'x'.repeat(WORKSPACE_LIMITS.bytes + 1)) as { error: string }).error, /at most/);
  } finally {
    temp.cleanup();
  }
});
