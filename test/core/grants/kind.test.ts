// Documented behaviour: signer.md and concepts.md "Web grants" — the signer
// signs a run's grants from the job's `web` block on the vault's `main` as it
// fetches it itself, never from the request; it allows one unexpired grant
// per job, kept across restarts; a grant expires the job's run time plus a
// minute after it is issued; fan-out items get only the closed entries and
// those marked `to: all`; anything it cannot be sure of is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallationConfig, type SignerConfig } from '../../../src/core/config/index.ts';
import { verifyGrant, webGrantKind, type IssuedGrants } from '../../../src/core/grants/index.ts';
import { openSignerStore } from '../../../src/core/operations/index.ts';
import { answerSignerMessage, newSigningKey, signingKeyFrom, type SignerDeps, type SigningKey } from '../../../src/core/signing/index.ts';
import { fakeClock, type FakeClock } from '../../support/clock.ts';
import { createTempRepo, gitFor, type TempRepo } from '../../support/git-repo.ts';
import { testHost } from '../../support/host.ts';
import { createTempDir, type TempDir } from '../../support/temp-dir.ts';

const TRACE = '01KABCDEFGHJKMNPQRSTVWXYZ0';
const TRACE2 = '01KABCDEFGHJKMNPQRSTVWXYZ1';
const JOB = 'jobs/watch.md';
const WEB = [
  'web:',
  '  requests: 9',
  '  allow:',
  '    - url: https://api.example.net/v3/entry?typeClass={tc}',
  '      tc: [W1, X2]',
  '    - url: https://api.example.net/v3/models/{model}/info',
  '      model: from-response',
  '    - url: https://www.example-motors.com.au/*',
].join('\n');
const job = (web = WEB, ttl = '30m'): string => `---\napplies-when: [{ on: timer, schedule: "0 6 * * *", effect: spawn }]\nbudget: { tokens: 1000, ttl: ${ttl} }\nactor: gardener\n${web}\n---\nWatch.\n`;

interface Setup {
  readonly forge: TempRepo;
  readonly dir: TempDir;
  readonly clock: FakeClock;
  readonly key: SigningKey;
  readonly config: SignerConfig;
  deps(): SignerDeps;
  sign(params: Record<string, unknown>): Promise<{ ok: boolean; value?: IssuedGrants; reason?: string; text?: string }>;
  close(): void;
}

function setup(extraConfig = ''): Setup {
  const forge = createTempRepo();
  forge.write('_contract.md', '---\nvault: { id: home }\n---\n');
  forge.write(JOB, job());
  forge.commit('the job');
  const dir = createTempDir('pav-signer-');
  const clock = fakeClock('2026-10-31T00:00:00.000Z');
  const made = signingKeyFrom(newSigningKey().pem);
  if (!made.ok) throw new Error('key');
  const parsed = parseInstallationConfig(`signer:\n  key: "\${KEY}"\n  vaults: [{ id: home, url: ${JSON.stringify(forge.path)}, local: true }]\n${extraConfig}`, testHost());
  if (!parsed.ok || parsed.value.signer === undefined) throw new Error(JSON.stringify(parsed));
  const config = parsed.value.signer;
  const stores: { close(): void }[] = [];
  const deps = (): SignerDeps => {
    const store = openSignerStore({ signerDb: dir.file('signer.sqlite') });
    if (!store.ok) throw new Error('store');
    stores.push(store.value);
    return { git: gitFor(forge), store: store.value, clock, repos: dir.file('repos'), issuer: 'alice@studio' };
  };
  let kind = webGrantKind(deps(), config);
  return {
    forge, dir, clock, key: made.value, config,
    deps: () => {
      // A restart: a new store connection and a new kind over the same file.
      kind = webGrantKind(deps(), config);
      return deps();
    },
    async sign(params) {
      const signed = await kind.sign(params, made.value);
      return signed.ok ? { ok: true, value: signed.value as IssuedGrants } : { ok: false, reason: signed.error.reason, text: signed.error.text };
    },
    close() {
      for (const s of stores) s.close();
      forge.cleanup();
      dir.cleanup();
    },
  };
}

function withSigner(run: (s: Setup) => Promise<void>, extraConfig?: string): () => Promise<void> {
  return async () => {
    const s = setup(extraConfig);
    try {
      await run(s);
    } finally {
      s.close();
    }
  };
}

test('the grants say what the job\'s web block on main says, signed for this run, for scripts and items apart', withSigner(async (s) => {
  const signed = await s.sign({ vault: 'home', job: JOB, trace: TRACE });
  if (!signed.ok || signed.value === undefined) assert.fail(signed.text);
  const { script, item, expires, main, blob } = signed.value;
  assert.equal(main, s.forge.git('rev-parse', 'main'));
  assert.equal(blob, s.forge.git('rev-parse', `main:${JOB}`));
  assert.equal(expires, '2026-10-31T00:31:00.000Z', 'its run time plus a minute');
  const forScripts = verifyGrant(script, [s.key.jwk], s.clock.now());
  const forItems = verifyGrant(item ?? '', [s.key.jwk], s.clock.now());
  assert.ok(forScripts.ok && forItems.ok);
  assert.deepEqual(forScripts.value, {
    iss: 'alice@studio', jti: TRACE, aud: 'script', iat: 1793404800, exp: 1793406660, vault: 'home', job: JOB, blob, main, requests: 9,
    allow: [
      { url: 'https://api.example.net/v3/entry?typeClass={tc}', params: { tc: ['W1', 'X2'] } },
      { url: 'https://api.example.net/v3/models/{model}/info', params: { model: 'from-response' } },
      { url: 'https://www.example-motors.com.au/*' },
    ],
  });
  assert.equal(forItems.value.aud, 'item');
  assert.equal(forItems.value.jti, TRACE, 'one ID for both, so the broker counts their requests together');
  assert.deepEqual(forItems.value.allow.map((a) => a.url), ['https://api.example.net/v3/entry?typeClass={tc}', 'https://api.example.net/v3/models/{model}/info'], 'the open entry is the scripts\' only');
}));

test('the allowance is never taken from the request: a request carrying anything but vault, job and trace is refused', withSigner(async (s) => {
  const refused = await s.sign({ vault: 'home', job: JOB, trace: TRACE, allow: [{ url: 'https://evil.example/*' }] });
  assert.equal(refused.reason, 'invalid-request');
  assert.match(refused.text ?? '', /params\.allow: unknown key/);
  assert.equal((await s.sign({ vault: 'home', job: '../outside.md', trace: TRACE })).reason, 'invalid-request');
  assert.equal((await s.sign({ vault: 'home', job: JOB, trace: 'not-a-trace' })).reason, 'invalid-request');
}));

test('only main counts: a web block on a branch, or in the working tree, is not what is signed', withSigner(async (s) => {
  s.forge.git('checkout', '--quiet', '-b', 'actor/gardener');
  s.forge.write(JOB, job(`web:\n  requests: 9999\n  allow:\n    - url: https://capture.example/{payload}`));
  s.forge.commit('widen it on a branch');
  s.forge.write(JOB, job('web:\n  requests: 5000\n  allow:\n    - url: https://other.example/*'));
  const signed = await s.sign({ vault: 'home', job: JOB, trace: TRACE });
  assert.ok(signed.ok && signed.value !== undefined);
  const claims = verifyGrant(signed.value.script, [s.key.jwk], s.clock.now());
  assert.ok(claims.ok);
  assert.equal(claims.value.requests, 9, 'main\'s block, not the branch\'s or the working tree\'s');
}));

test('one live grant per job: a second request is refused until the first expires, also after a restart', withSigner(async (s) => {
  assert.equal((await s.sign({ vault: 'home', job: JOB, trace: TRACE })).ok, true);
  const again = await s.sign({ vault: 'home', job: JOB, trace: TRACE2 });
  assert.equal(again.reason, 'grant-live');
  assert.match(again.text ?? '', /already holds a grant, until 2026-10-31T00:31:00\.000Z/);
  s.deps();
  assert.equal((await s.sign({ vault: 'home', job: JOB, trace: TRACE2 })).reason, 'grant-live', 'the record outlives a restart');
  s.clock.advance(31 * 60_000);
  assert.equal((await s.sign({ vault: 'home', job: JOB, trace: TRACE2 })).ok, true, 'once it has expired, the next run may have one');
}));

test('anything the signer cannot be sure of is no grant', withSigner(async (s) => {
  assert.equal((await s.sign({ vault: 'elsewhere', job: JOB, trace: TRACE })).reason, 'unknown-vault');
  assert.equal((await s.sign({ vault: 'home', job: 'jobs/none.md', trace: TRACE })).reason, 'no-such-job');
  s.forge.write('jobs/plain.md', '---\nbudget: { tokens: 1, ttl: 1m }\n---\nNo web.\n');
  s.forge.write('jobs/bad.md', job('web:\n  requests: 3\n  allow:\n    - url: https://user@example.net/'));
  s.forge.write('jobs/open.md', job('web:\n  requests: 3\n  allow:\n    - url: https://*.example-motors.com/*'));
  s.forge.write('jobs/unbudgeted.md', `---\n${WEB}\n---\nNo budget.\n`);
  s.forge.write('jobs/broken.md', '---\nweb: [unclosed\n---\n');
  s.forge.commit('more jobs');
  assert.equal((await s.sign({ vault: 'home', job: 'jobs/plain.md', trace: TRACE })).reason, 'no-web-block');
  assert.equal((await s.sign({ vault: 'home', job: 'jobs/bad.md', trace: TRACE })).reason, 'invalid-web-block');
  const open = await s.sign({ vault: 'home', job: 'jobs/open.md', trace: TRACE });
  assert.equal(open.reason, 'too-open', 'a wildcard under the minimum is no grant at all, not a grant without that entry');
  assert.equal((await s.sign({ vault: 'home', job: 'jobs/unbudgeted.md', trace: TRACE })).reason, 'no-budget');
  assert.equal((await s.sign({ vault: 'home', job: 'jobs/broken.md', trace: TRACE })).reason, 'unreadable-job');
}));

test('the wildcard minimum is the signer\'s setting', withSigner(async (s) => {
  s.forge.write(JOB, job('web:\n  requests: 3\n  allow:\n    - url: https://*.example-motors.com/*'));
  s.forge.commit('a 17-character wildcard');
  assert.equal((await s.sign({ vault: 'home', job: JOB, trace: TRACE })).ok, true);
}, '  web-grant: { wildcard-min: 15 }'));

test('a main that cannot be fetched is no grant', withSigner(async (s) => {
  const gone = { ...s.config, vaults: [{ id: 'home', url: s.dir.file('no-such-repo'), local: true }] };
  const signed = await webGrantKind(s.deps(), gone).sign({ vault: 'home', job: JOB, trace: TRACE }, s.key);
  assert.deepEqual(signed.ok ? 'signed' : signed.error.reason, 'fetch-failed');
}));

test('the signer answers ping with its key and kinds, sign by kind, and refuses any other method or kind', withSigner(async (s) => {
  const kinds = [webGrantKind(s.deps(), s.config)];
  assert.deepEqual(await answerSignerMessage(kinds, s.key, '1.0.0', { id: 1, method: 'ping' }), { id: 1, ok: true, result: { version: '1.0.0', kid: s.key.kid, kinds: { 'web-grant': { wildcardMin: 20 } } } });
  const signed = await answerSignerMessage(kinds, s.key, '1.0.0', { id: 2, method: 'sign', params: { kind: 'web-grant', vault: 'home', job: JOB, trace: TRACE } });
  assert.equal(signed?.ok, true);
  assert.deepEqual(await answerSignerMessage(kinds, s.key, '1.0.0', { id: 3, method: 'sign', params: { kind: 'anything', what: 'x' } }),
    { id: 3, ok: false, error: { reason: 'unknown-kind', text: 'the signer makes no statement of that kind' } });
  assert.equal((await answerSignerMessage(kinds, s.key, '1.0.0', { id: 4, method: 'export-key' }))?.ok, false);
  assert.equal(await answerSignerMessage(kinds, s.key, '1.0.0', 'not a request'), undefined);
}));
