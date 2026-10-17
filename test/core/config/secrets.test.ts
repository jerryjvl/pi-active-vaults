// Documented behaviour: secrets are `${ENV}` references or `!command`, never
// literals; they are resolved at the point of use and never appear in errors
// (concepts.md "Installation", notifications.md "Secrets are never exposed").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSecretRef,
  resolveSecret,
  shellCommandRunner,
  type CommandRunner,
  type SecretRef,
} from '../../../src/core/config/index.ts';

function ref(value: string): SecretRef {
  const parsed = parseSecretRef(value, 'models.embed.token');
  if (!parsed.ok) assert.fail(`expected a secret reference for ${value}`);
  return parsed.value;
}

const neverRuns: CommandRunner = async () => assert.fail('no command should run');

test('an environment reference and a command are recognised', () => {
  assert.deepEqual(ref('${EMBED_TOKEN}'), { kind: 'env', name: 'EMBED_TOKEN', where: 'models.embed.token' });
  assert.deepEqual(ref('!secret-tool lookup service vault'), {
    kind: 'command',
    command: 'secret-tool lookup service vault',
    where: 'models.embed.token',
  });
});

test('a literal secret is refused, and the error never repeats the value', () => {
  for (const literal of ['sk-live-abcdef', 'pa$$word', '${bad name}', '${A}${B}', 'prefix-${A}', '!', '!   ', '', 42, null]) {
    const parsed = parseSecretRef(literal, 'forges[0].token');
    assert.equal(parsed.ok, false, String(literal));
    if (!parsed.ok) {
      assert.equal(parsed.error.path, 'forges[0].token');
      if (typeof literal === 'string' && literal.length > 3) {
        assert.ok(!parsed.error.message.includes(literal), 'error must not echo the value');
      }
    }
  }
});

test('an environment reference resolves from the injected environment', async () => {
  const result = await resolveSecret(ref('${EMBED_TOKEN}'), { env: { EMBED_TOKEN: 's3cret' }, runCommand: neverRuns });
  assert.deepEqual(result, { ok: true, value: 's3cret' });
});

test('an unset or empty variable fails closed, naming the config field but not any value', async () => {
  for (const env of [{}, { EMBED_TOKEN: '' }]) {
    const result = await resolveSecret(ref('${EMBED_TOKEN}'), { env, runCommand: neverRuns });
    assert.deepEqual(result, { ok: false, error: { reason: 'env-unset', where: 'models.embed.token' } });
  }
});

test('a command resolves to its output with the trailing newline removed', async () => {
  const runCommand: CommandRunner = async (command) => {
    assert.equal(command, 'print-it');
    return { exitCode: 0, stdout: 's3cret\r\n' };
  };
  const result = await resolveSecret(ref('!print-it'), { env: {}, runCommand });
  assert.deepEqual(result, { ok: true, value: 's3cret' });
});

test('a failing, timed-out or empty command fails closed and leaks neither output nor command', async () => {
  const cases: [Awaited<ReturnType<CommandRunner>>, string][] = [
    [{ exitCode: 1, stdout: 'partial-s3cret' }, 'command-failed'],
    [{ exitCode: null, stdout: 'partial-s3cret' }, 'command-failed'],
    [{ exitCode: 0, stdout: '\n' }, 'empty'],
  ];
  for (const [outcome, reason] of cases) {
    const result = await resolveSecret(ref('!lookup --password hunter2'), { env: {}, runCommand: async () => outcome });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.reason, reason);
      const text = JSON.stringify(result.error);
      assert.ok(!text.includes('s3cret') && !text.includes('hunter2'), text);
    }
  }
});

test('a command that cannot be started is a failure value, not an exception', async () => {
  const runCommand: CommandRunner = async () => {
    throw new Error('spawn failed: hunter2');
  };
  const result = await resolveSecret(ref('!lookup'), { env: {}, runCommand });
  assert.deepEqual(result, { ok: false, error: { reason: 'command-failed', where: 'models.embed.token' } });
});

test('the real shell runner returns output and exit status, and enforces the timeout', { skip: process.platform === 'win32' }, async () => {
  const node = JSON.stringify(process.execPath);
  assert.deepEqual(await shellCommandRunner(`${node} -e "process.stdout.write('abc')"`, { timeoutMs: 10_000 }), {
    exitCode: 0,
    stdout: 'abc',
  });
  const failed = await shellCommandRunner(`${node} -e "process.exit(3)"`, { timeoutMs: 10_000 });
  assert.equal(failed.exitCode, 3);
  const slow = await shellCommandRunner(`${node} -e "setTimeout(()=>{},5000)"`, { timeoutMs: 100 });
  assert.equal(slow.exitCode, null);
});
