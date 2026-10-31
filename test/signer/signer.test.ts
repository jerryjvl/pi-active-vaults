// Documented behaviour: signer.md — the signer starts only with a `signer`
// section and a key it can use; it listens on its socket, for its user only
// or with `socket-access: group` for its group too; asked over that socket,
// it signs a run's web grants from the vault's main it fetches itself, which
// verify with its public key; it logs each statement made or refused, never
// the statement or the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { pingSigner, requestGrants, verifyGrant } from '../../src/core/grants/index.ts';
import { newSigningKey } from '../../src/core/signing/index.ts';
import { startSigner } from '../../src/signer/signer.ts';
import { gitFor } from '../support/git-repo.ts';
import { withInstallation, type TestInstallation } from '../support/installation.ts';
import { createTempDir } from '../support/temp-dir.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'Unix domain socket modes' : false };
const TRACE = '01KABCDEFGHJKMNPQRSTVWXYZ0';
const JOB = '---\napplies-when: [{ on: external, name: go, effect: spawn }]\nbudget: { tokens: 100, ttl: 10m }\nactor: gardener\nweb:\n  requests: 2\n  allow:\n    - url: https://api.example.net/v3/*\n---\nWatch.\n';

/** A test installation that is also a signer, for its own vault, read from its checkout (local: true). */
function withSignerInstallation(run: (t: TestInstallation, jwk: ReturnType<typeof newSigningKey>['jwk'], log: string[]) => Promise<void>, extra = ''): () => Promise<void> {
  const dir = createTempDir('pav-key-');
  const { pem, jwk } = newSigningKey();
  writeFileSync(dir.file('key.pem'), pem, { mode: 0o600 });
  return async () => {
    try {
      await withInstallation(async (t) => {
        t.repo.write('jobs/watch.md', JOB);
        t.accept(t.repo.commit('a web job'));
        await run(t, jwk, []);
      }, { config: `signer:\n  key: "!cat ${dir.file('key.pem')}"\n  vaults: [{ id: home, url: ${JSON.stringify('/placeholder')}, local: true }]\n${extra}` })();
    } finally {
      dir.cleanup();
    }
  };
}

/** Starts the signer of `t`, its vault's URL being its own checkout. */
async function started(t: TestInstallation, log: string[]) {
  const config = t.dir.file('config', 'config.yaml');
  const { readFileSync } = await import('node:fs');
  writeFileSync(config, readFileSync(config, 'utf8').replace('"/placeholder"', JSON.stringify(t.repo.path)));
  const signer = await startSigner({ host: t.host, git: gitFor(t.repo), clock: t.clock, log: (line) => log.push(line) });
  if (!signer.ok) assert.fail(JSON.stringify(signer.error));
  return signer.value;
}

test('asked over its socket, the signer signs a run\'s grants from main, which verify with its public key', posixOnly, withSignerInstallation(async (t, jwk, log) => {
  const signer = await started(t, log);
  try {
    assert.equal(signer.socket, t.installation.paths.signerSocket, 'the default socket in its state directory');
    assert.equal(signer.kid, jwk.kid);
    assert.equal((statSync(signer.socket).mode & 0o777).toString(8), '600', 'its user\'s only, unless group access is asked for');
    const ping = await pingSigner(signer.socket);
    assert.deepEqual(ping.ok && ping.value.kid, jwk.kid);
    assert.deepEqual(ping.ok && ping.value.wildcardMin, 20);
    const grants = await requestGrants(signer.socket, { vault: 'home', job: 'jobs/watch.md', trace: TRACE });
    assert.ok(grants.ok, JSON.stringify(grants));
    const claims = verifyGrant(grants.value.script, [jwk], t.clock.now());
    assert.ok(claims.ok);
    assert.deepEqual([claims.value.vault, claims.value.job, claims.value.jti, claims.value.requests], ['home', 'jobs/watch.md', TRACE, 2]);
    assert.equal(grants.value.item, undefined, 'its one entry is open, so its fan-out items get none');
    const again = await requestGrants(signer.socket, { vault: 'home', job: 'jobs/watch.md', trace: '01KABCDEFGHJKMNPQRSTVWXYZ1' });
    assert.deepEqual(again.ok ? 'granted' : again.error, { reason: 'refused', refusal: 'jobs/watch.md already holds a grant, until 2026-01-01T00:11:00.000Z' });
    assert.deepEqual(log.map((l) => l.replace(/(trace=[0-9A-Z]+).*$/, '$1')), [
      `vault signer: signed kind=web-grant vault=home job=jobs/watch.md trace=${TRACE}`,
      'vault signer: refused kind=web-grant vault=home job=jobs/watch.md trace=01KABCDEFGHJKMNPQRSTVWXYZ1',
    ]);
    assert.ok(log.every((l) => !l.includes(grants.value.script) && !l.includes('PRIVATE KEY')), 'never the grant or the key');
  } finally {
    await signer.stop();
  }
}));

test('with socket-access: group, a daemon running as another user of its group can reach it', posixOnly, withSignerInstallation(async (t, _jwk, log) => {
  const signer = await started(t, log);
  try {
    assert.equal((statSync(signer.socket).mode & 0o777).toString(8), '660');
  } finally {
    await signer.stop();
  }
}, '  socket-access: group'));

test('a signer without its section, or without a key it can use, does not start', withInstallation(async (t) => {
  assert.deepEqual(await startSigner({ host: t.host, clock: t.clock }), { ok: false, error: { reason: 'not-configured' } });
  const bad = t.dir.file('config', 'config.yaml');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(bad, '\nsigner: { key: "${NO_SUCH_KEY}" }\n');
  assert.deepEqual(await startSigner({ host: t.host, clock: t.clock }), { ok: false, error: { reason: 'no-key', detail: 'signer.key: env-unset' } });
}));
