// Documented behaviour: notifications.md "Use" — `builtin:notify --to <alias>
// --subject <text> [--body-file <file>] [--key <id>] [--markdown | --plain]`,
// with the body from `--body-file` or standard input, a Markdown body (a `.md`
// file by default) sent as text with an HTML alternative; raw addresses are rejected. It runs as a
// built-in script: available to every vault, never shadowed. Its exit
// statuses follow the CLI's: 2 for a usage error, 3 for a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notifyBuiltin, parseNotifyConfig, type NotifyDeps } from '../../../src/core/notify/index.ts';
import { runScript, type ScriptRunOptions } from '../../../src/core/scripts/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { TEST_CA, startSmtpStub, type SmtpStub } from '../../support/smtp-server.ts';
import { withTestVault, type TestVault } from '../../support/vault.ts';

const TRACE = '01JABCDEFGHJKMNPQRSTVWXYZ0';

async function withNotify(v: TestVault, run: (stub: SmtpStub, options: ScriptRunOptions) => Promise<void>): Promise<void> {
  const stub = await startSmtpStub({ mode: 'tls', password: 'pw' });
  try {
    const config = parseNotifyConfig({
      from: 'vault@example.net',
      recipients: { me: 'me@example.net' },
      transport: { type: 'smtp', host: '127.0.0.1', port: 465, user: 'vault', password: '${PW}' },
    });
    assert.ok(config.ok && config.value !== undefined);
    const deps: NotifyDeps = {
      store: v.store, config: config.value, clock: fakeClock(), env: {},
      secrets: { env: { PW: 'pw' }, runCommand: async () => assert.fail('no command') }, smtp: { port: stub.port, ca: TEST_CA, timeoutMs: 5000 },
    };
    const options: ScriptRunOptions = {
      kind: 'script', builtins: [notifyBuiltin(deps, { trace: TRACE })], cwd: v.repo.path, env: {}, timeoutMs: 10_000, os: 'linux', sandbox: 'none',
    };
    await run(stub, options);
  } finally {
    await stub.close();
  }
}

test('builtin:notify sends the body from standard input to an alias, and reports the outcome and Message-ID', withTestVault(async (v) => {
  v.accept();
  await withNotify(v, async (stub, options) => {
    const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'builtin:notify', ['--to', 'me', '--subject', 'Digest', '--key', 'd1'], { ...options, input: 'Today\'s digest.\n' });
    assert.ok(ran.ok);
    assert.equal(ran.value.exitCode, 0, ran.value.stderr);
    assert.match(ran.value.stdout, new RegExp(`^sent <${TRACE}\\.[0-9a-f]{16}@example\\.net>\\n$`));
    assert.match(stub.messages[0]?.data ?? '', /Today's digest\./);
  });
}));

test('builtin:notify reads the body from --body-file, relative to where it runs', withTestVault(async (v) => {
  v.accept();
  writeFileSync(join(v.repo.path, 'body.txt'), 'From a file.\n');
  await withNotify(v, async (stub, options) => {
    const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'builtin:notify', ['--to', 'me', '--subject', 'S', '--body-file', 'body.txt'], options);
    assert.ok(ran.ok && ran.value.exitCode === 0, ran.ok ? ran.value.stderr : '');
    assert.match(stub.messages[0]?.data ?? '', /From a file\./);
  });
}));

test('builtin:notify refuses raw addresses, unknown options and missing arguments, sending nothing', withTestVault(async (v) => {
  v.accept();
  await withNotify(v, async (stub, options) => {
    const run = (args: string[]) => runScript({ git: v.git, store: v.store, vault: v.vault }, 'builtin:notify', args, { ...options, input: 'x' });
    const raw = await run(['--to', 'me@example.net', '--subject', 'S']);
    assert.ok(raw.ok);
    assert.deepEqual([raw.value.exitCode, raw.value.stderr], [3, 'refused: raw-address\n']);
    const unknown = await run(['--to', 'me', '--subject', 'S', '--cc', 'x']);
    assert.ok(unknown.ok && unknown.value.exitCode === 2);
    const missing = await run(['--to', 'me']);
    assert.ok(missing.ok && missing.value.exitCode === 2);
    assert.deepEqual(stub.messages, []);
  });
}));

test('a Markdown body file is sent readable: front matter dropped, as text with an HTML alternative; --plain sends it as it is', withTestVault(async (v) => {
  v.accept();
  writeFileSync(join(v.repo.path, 'digest.md'), '---\ntype: digest\n---\n\n# Digest\n\n1. **News** [Source](https://example.org/a)\n');
  await withNotify(v, async (stub, options) => {
    const send = (args: string[]) => runScript({ git: v.git, store: v.store, vault: v.vault }, 'builtin:notify', ['--to', 'me', '--subject', 'S', '--body-file', 'digest.md', ...args], options);
    const rendered = await send([]);
    assert.ok(rendered.ok && rendered.value.exitCode === 0, rendered.ok ? rendered.value.stderr : '');
    const data = stub.messages[0]?.data ?? '';
    assert.match(data, /multipart\/alternative/);
    assert.match(data, /Content-Type: text\/plain/);
    assert.match(data, /Content-Type: text\/html/);
    assert.doesNotMatch(data, /type: digest/, 'no front matter in either part');
    assert.match(data, /<h1>Digest<\/h1>/);
    const plain = await send(['--plain']);
    assert.ok(plain.ok && plain.value.exitCode === 0);
    const second = stub.messages[1]?.data ?? '';
    assert.doesNotMatch(second, /text\/html/);
    assert.match(second, /type: digest/);
    const both = await send(['--plain', '--markdown']);
    assert.ok(both.ok);
    assert.equal(both.value.exitCode, 2);
  });
}));

test('--markdown renders any body, standard input included', withTestVault(async (v) => {
  v.accept();
  await withNotify(v, async (stub, options) => {
    const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'builtin:notify', ['--to', 'me', '--subject', 'S', '--markdown'], { ...options, input: '**Bold** news\n' });
    assert.ok(ran.ok && ran.value.exitCode === 0, ran.ok ? ran.value.stderr : '');
    assert.match(stub.messages[0]?.data ?? '', /<strong>Bold<\/strong> news/);
  });
}));
