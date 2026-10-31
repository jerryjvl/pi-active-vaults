// Documented behaviour: concepts.md "Web grants" and daemon.md "Execution" —
// before it starts a run whose job has a `web` block, the daemon asks the
// signer for the run's grants and puts them in the run file; it never signs
// itself, and a run the signer refuses, or cannot be asked about, runs
// without grants. The run's scripts in its own vault get the script grant as
// VAULT_WEB_GRANT; its fan-out items' MCP servers named in `web-grants`, and
// only HTTP ones, get the item grant as the X-Vault-Grant header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRANT_HEADER, parseRunGrants, withGrantHeader } from '../../../src/core/grants/index.ts';
import { listSpawns } from '../../../src/core/queue/index.ts';
import { callerOf, parseRunContext, renderRunContext, type RunContext, type VaultSession } from '../../../src/core/sessions/index.ts';
import { listenSocket, type SocketServer } from '../../../src/core/socket/index.ts';
import { readFullLog } from '../../../src/core/traces/index.ts';
import { automationFor, fakePi, jobDocument } from '../../support/daemon.ts';
import { withInstallation, type TestInstallation } from '../../support/installation.ts';
import { createTempDir } from '../../support/temp-dir.ts';
import { scriptSource } from '../../support/vault.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts and sockets' : false };
const SCRIPT_GRANT = 'eyJzY3JpcHQ.eyJjbGFpbXM.c2lnbmF0dXJl';
const ITEM_GRANT = 'eyJpdGVt.eyJjbGFpbXM.c2lnbmF0dXJl';
const WEB = 'web:\n  requests: 3\n  allow:\n    - url: https://api.example.net/v3/{x}\n      x: [a]';
const MANUAL = '[{ on: external, name: go, effect: spawn }]';

test('a run file carries its grants, read strictly', () => {
  const run: RunContext = {
    vault: 'home', document: 'jobs/a.md', actor: 'gardener', model: 'agent', trace: '01JABCDEFGHJKMNPQRSTVWXYZ1',
    event: { kind: 'manual', vault: 'home' } as unknown as RunContext['event'], grants: { script: SCRIPT_GRANT, item: ITEM_GRANT },
  };
  assert.deepEqual(parseRunContext(renderRunContext(run)), { ok: true, value: run });
  const bad = parseRunContext(renderRunContext({ ...run, grants: { script: 'not a grant' } }));
  assert.ok(!bad.ok);
  assert.deepEqual(bad.error.map((i) => i.path), ['grants.script']);
  assert.ok(!parseRunGrants({ script: `${'a'.repeat(9000)}.b.c` }).ok, 'a grant larger than a header carries is no grant');
});

test('a headless run\'s calls carry its script grant for its own vault; an interactive session\'s carry none', withInstallation(async (t) => {
  const base = { id: 's', trace: '01JABCDEFGHJKMNPQRSTVWXYZ1', tainted: false } as unknown as VaultSession;
  assert.equal(callerOf(t.context, base, t.repo.path).webGrant, undefined);
  const run = { vault: 'home', grants: { script: SCRIPT_GRANT, item: ITEM_GRANT } } as unknown as RunContext;
  assert.deepEqual(callerOf(t.context, { ...base, run } as VaultSession, t.repo.path).webGrant, { vault: 'home', token: SCRIPT_GRANT });
}));

test('a run\'s scripts in its own vault get its grant as VAULT_WEB_GRANT; elsewhere, and outside a run, none', posixOnly, withInstallation(async (t) => {
  t.repo.write('.vault/scripts/grant.sh', scriptSource('grant', 'echo "grant: ${VAULT_WEB_GRANT:-none}"'));
  t.repo.commit('script');
  t.accept();
  assert.equal((await t.run('script', { name: 'grant' }, { caller: { webGrant: { vault: 'home', token: SCRIPT_GRANT } } })).text, `grant: ${SCRIPT_GRANT}`);
  assert.equal((await t.run('script', { name: 'grant' }, { caller: { webGrant: { vault: 'other', token: SCRIPT_GRANT } } })).text, 'grant: none');
  assert.equal((await t.run('script', { name: 'grant' })).text, 'grant: none');
}));

test('an item grant goes in the header of the named HTTP servers only, beside their own headers', () => {
  const configs = {
    web: { url: 'http://127.0.0.1:3083', headers: { Accept: 'application/json' } },
    docs: { url: 'https://docs.example.net/mcp' },
    local: { command: 'node', args: ['server.js'] },
  };
  assert.deepEqual(withGrantHeader(configs, ['web', 'local'], ITEM_GRANT), {
    web: { url: 'http://127.0.0.1:3083', headers: { Accept: 'application/json', [GRANT_HEADER]: ITEM_GRANT } },
    docs: { url: 'https://docs.example.net/mcp' },
    local: { command: 'node', args: ['server.js'] },
  });
  assert.deepEqual(withGrantHeader(configs, ['web'], undefined), configs, 'no grant, no header');
});

/** A stand-in signer at a socket of its own: what it was asked, answered by `answer`. */
async function stubSigner(path: string, answer: (params: Record<string, unknown>) => { ok: boolean; result?: unknown; error?: unknown }) {
  const asked: Record<string, unknown>[] = [];
  const server = await listenSocket(path, (channel) => channel.onMessage((message) => {
    const { id, params } = message as { id: unknown; params: Record<string, unknown> };
    asked.push(params);
    channel.send({ id, ...answer(params) });
  }));
  if (!server.ok) throw new Error(JSON.stringify(server.error));
  return { asked, server: server.value as SocketServer };
}

function withSignerSocket(run: (t: TestInstallation, socket: string) => Promise<void>): () => Promise<void> {
  const dir = createTempDir('pav-sig-');
  const socket = dir.file('signer.sock');
  return async () => {
    try {
      await withInstallation((t) => run(t, socket), { config: `web-grants: { signer: ${JSON.stringify(socket)}, servers: [web] }` })();
    } finally {
      dir.cleanup();
    }
  };
}

async function runJob(t: TestInstallation, documents: Record<string, string>): Promise<{ run: Record<string, unknown> | undefined; trace: string }> {
  for (const [path, text] of Object.entries(documents)) t.repo.write(path, text);
  t.accept(t.repo.commit('jobs'));
  assert.equal((await t.run('run', { document: 'jobs/a.md' })).status, 'ok');
  const pi = fakePi(t, { '*': 'nothing' });
  const automation = automationFor(t, pi);
  await automation.schedule();
  await automation.idle();
  const [spawn] = listSpawns(t.context.state);
  return { run: pi.starts()[0]?.run, trace: spawn?.trace ?? '' };
}

const withWeb = (conditions: string): string => jobDocument(conditions).replace('actor: gardener\n', `actor: gardener\n${WEB}\n`);

test('the daemon asks the signer for a web job\'s grants by vault, job and trace, and hands them to the run', posixOnly, withSignerSocket(async (t, socket) => {
  const signer = await stubSigner(socket, () => ({ ok: true, result: { script: SCRIPT_GRANT, item: ITEM_GRANT, expires: 'x', main: 'm', blob: 'b' } }));
  try {
    const { run, trace } = await runJob(t, { 'jobs/a.md': withWeb(MANUAL) });
    assert.deepEqual(signer.asked, [{ kind: 'web-grant', vault: 'home', job: 'jobs/a.md', trace }], 'it names the run, never the allowance');
    assert.deepEqual(run?.['grants'], { script: SCRIPT_GRANT, item: ITEM_GRANT });
  } finally {
    await signer.server.close();
  }
}));

test('a refused request is a run without grants, with why in its log', posixOnly, withSignerSocket(async (t, socket) => {
  const signer = await stubSigner(socket, () => ({ ok: false, error: { reason: 'grant-live', text: 'jobs/a.md already holds a grant, until then' } }));
  try {
    const refused = await runJob(t, { 'jobs/a.md': withWeb(MANUAL) });
    assert.equal(refused.run?.['grants'], undefined, 'the run still runs, without grants');
    assert.ok(readFullLog(t.installation.paths.logs, refused.trace).some((l) => l.name === 'daemon' && l.text.includes('"no-grants"') && l.text.includes('already holds a grant')));
  } finally {
    await signer.server.close();
  }
}));

test('with no signer answering, a web job runs without grants', posixOnly, withSignerSocket(async (t) => {
  const { run, trace } = await runJob(t, { 'jobs/a.md': withWeb(MANUAL) });
  assert.equal(run?.['grants'], undefined);
  assert.ok(readFullLog(t.installation.paths.logs, trace).some((l) => l.name === 'daemon' && l.text.includes('"no-grants"') && l.text.includes('the signer did not answer')));
}));

test('a job without a web block never asks the signer', posixOnly, withSignerSocket(async (t, socket) => {
  const signer = await stubSigner(socket, () => ({ ok: true, result: { script: SCRIPT_GRANT } }));
  try {
    const { run } = await runJob(t, { 'jobs/a.md': jobDocument(MANUAL) });
    assert.deepEqual(signer.asked, []);
    assert.equal(run?.['grants'], undefined);
  } finally {
    await signer.server.close();
  }
}));
