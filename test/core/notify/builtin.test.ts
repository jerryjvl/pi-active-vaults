// Documented behaviour: notifications.md "Use" — `builtin:notify --to <alias>
// --subject <text> [--body-file <file>] [--key <id>]`, with the body from
// `--body-file` or standard input; raw addresses are rejected. It runs as a
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
