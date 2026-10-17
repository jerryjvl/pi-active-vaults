// Documented behaviour: cli.md — in forge mode, `vault propose <actor>` pushes
// the actor branch and opens or updates its pull request, and `vault sync`
// fetches first: the forge's main becomes the accepted main. concepts.md —
// the package never pushes main. Against a local bare repository behind the
// forge's URL and a stub forge API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptedMain } from '../../../src/core/integrity/index.ts';
import { createTempRepo } from '../../support/git-repo.ts';
import { FORGE_TOKEN, startForgeStub } from '../../support/forge-stub.ts';
import { withInstallation, writeFiles } from '../../support/installation.ts';

const REMOTE = 'https://git.example.net/home/vault.git';

test('propose pushes the actor branch and opens its pull request; sync takes the forge\'s main as the accepted main', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'pav-forge-'));
  const stub = await startForgeStub('gitea', (branch) => execFileSync('git', ['-C', bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim());
  try {
    await withInstallation(async (t) => {
      t.repo.git('init', '--quiet', '--bare', bare);
      t.repo.git('remote', 'add', 'origin', REMOTE);
      t.repo.git('config', `url.${bare}.insteadOf`, REMOTE);
      t.repo.git('push', '--quiet', 'origin', 'main');

      assert.equal((await t.run('write', { path: 'notes/a.md', content: 'A', actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
      assert.equal((await t.run('commit', { message: 'A note', actor: 'gardener' })).status, 'ok');
      const proposed = await t.run('propose', { actor: 'gardener' });
      assert.equal(proposed.status, 'ok', proposed.text);
      assert.match(proposed.text, /^Opened pull request #1 \(.*\); vault\/policy: pending\.$/);
      const head = t.repo.git('rev-parse', 'refs/heads/actor/gardener');
      assert.equal(t.repo.git('-C', bare, 'rev-parse', 'refs/heads/actor/gardener'), head);
      assert.equal(t.repo.git('-C', bare, 'rev-parse', 'refs/heads/main'), t.repo.git('rev-parse', 'refs/heads/main'), 'main is never pushed');

      const clone = createTempRepo();
      let merged: string;
      try {
        clone.git('fetch', '--quiet', bare, 'main:refs/heads/forge-main');
        clone.git('checkout', '--quiet', 'forge-main');
        writeFiles(clone.path, { 'merged.md': 'merged in the forge' });
        merged = clone.commit('Merge pull request');
        clone.git('push', '--quiet', bare, 'HEAD:refs/heads/main');
      } finally {
        clone.cleanup();
      }
      const synced = await t.run('sync', {});
      assert.equal(synced.status, 'ok', synced.text);
      assert.match(synced.text, new RegExp(`the accepted main is ${merged}; main moved forward`));
      assert.equal(acceptedMain(t.context.state, 'home')?.sha, merged);
    }, {
      contract: { review: 'forge', extra: 'merge:\n  - { paths: ["**"], require: [checks, owner] }' },
      config: `forges:\n  - { host: git.example.net, type: gitea, token: "\${FORGE_TOKEN}", api: "${stub.api}" }`,
      env: { FORGE_TOKEN },
    })();
  } finally {
    await stub.server.close();
    rmSync(bare, { recursive: true, force: true });
  }
});
