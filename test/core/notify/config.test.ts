// Documented behaviour: notifications.md "Configuration" and "Guarantees" —
// recipients are aliases whose addresses exist only in the installation
// config, validated when it loads (exactly one `@`, ASCII, no separators);
// the password is a secret reference, never a literal; SMTP is port 465 (TLS
// from the start) or 587 (STARTTLS, required); `sendmail` passes the message
// to a configured command; limits bound volume. Problems are reported without
// repeating the values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotifyConfig } from '../../../src/core/notify/index.ts';

const EXAMPLE = {
  from: 'Vault <vault@example.net>',
  recipients: { me: 'me@example.net' },
  transport: { type: 'smtp', host: 'smtp.example.net', port: 465, user: 'vault@example.net', password: '!secret-tool lookup vault smtp' },
  limits: { 'per-hour': 10, 'max-bytes': 200000, cooldown: '12h' },
};

const issues = (value: unknown): string[] => {
  const parsed = parseNotifyConfig(value);
  return parsed.ok ? [] : parsed.error.map((i) => `${i.path}: ${i.message}`);
};

test('the documented example parses', () => {
  assert.deepEqual(parseNotifyConfig(EXAMPLE), {
    ok: true,
    value: {
      from: { name: 'Vault', address: 'vault@example.net' },
      recipients: { me: 'me@example.net' },
      transport: {
        type: 'smtp', host: 'smtp.example.net', port: 465, security: 'tls', user: 'vault@example.net',
        password: { kind: 'command', command: 'secret-tool lookup vault smtp', where: 'notify.transport.password' },
      },
      limits: { perHour: 10, maxBytes: 200000, cooldownMs: 12 * 3_600_000 },
    },
  });
});

test('port 587 requires STARTTLS, and no other port is accepted: there is no unencrypted submission', () => {
  const at = (port: unknown) => parseNotifyConfig({ ...EXAMPLE, transport: { ...EXAMPLE.transport, port } });
  const starttls = at(587);
  assert.ok(starttls.ok && starttls.value.transport.type === 'smtp' && starttls.value.transport.security === 'starttls');
  assert.deepEqual(issues({ ...EXAMPLE, transport: { ...EXAMPLE.transport, port: 25 } }), ['notify.transport.port: must be 465 (TLS) or 587 (STARTTLS)']);
});

test('a recipient address must be exactly one @, ASCII, without separators — and is never echoed in a problem', () => {
  for (const address of ['two@at@example.net', 'nobody', 'mé@example.net', 'me@example.net, them@example.net', 'Me <me@example.net>', 'me@', '@example.net', 'me@exa mple.net', 'me@example.net\r\nBcc: x@y']) {
    const found = issues({ ...EXAMPLE, recipients: { me: address } });
    assert.deepEqual(found, ['notify.recipients.me: must be a plain address: one @, ASCII, no spaces or separators'], address);
    assert.ok(!found.join().includes(address));
  }
  assert.deepEqual(issues({ ...EXAMPLE, recipients: { 'not an alias': 'me@example.net' } }), ['notify.recipients.not an alias: must be an alias of letters, digits, ".", "_" or "-"']);
  assert.deepEqual(issues({ ...EXAMPLE, recipients: {} }), ['notify.recipients: must name at least one recipient']);
});

test('the sender is an address, optionally with a display name', () => {
  const bare = parseNotifyConfig({ ...EXAMPLE, from: 'vault@example.net' });
  assert.ok(bare.ok);
  assert.deepEqual(bare.value.from, { address: 'vault@example.net' });
  assert.deepEqual(issues({ ...EXAMPLE, from: 'Vault <vault@example.net' }), ['notify.from: must be an address, or a name and an address in <>']);
  assert.deepEqual(issues({ ...EXAMPLE, from: 'Va"ult <vault@example.net>' }), ['notify.from: must be an address, or a name and an address in <>']);
});

test('the password is a secret reference, never a literal', () => {
  assert.equal(issues({ ...EXAMPLE, transport: { ...EXAMPLE.transport, password: 'hunter2' } }).length, 1);
  assert.ok(!issues({ ...EXAMPLE, transport: { ...EXAMPLE.transport, password: 'hunter2' } }).join().includes('hunter2'));
  const env = parseNotifyConfig({ ...EXAMPLE, transport: { ...EXAMPLE.transport, password: '${SMTP_PASSWORD}' } });
  assert.ok(env.ok && env.value.transport.type === 'smtp' && env.value.transport.password.kind === 'env');
});

test('a sendmail transport names its command and arguments', () => {
  const parsed = parseNotifyConfig({ ...EXAMPLE, transport: { type: 'sendmail', command: '/usr/bin/msmtp', args: ['--read-envelope-from', '-t'] } });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.transport, { type: 'sendmail', command: '/usr/bin/msmtp', args: ['--read-envelope-from', '-t'] });
  const defaults = parseNotifyConfig({ ...EXAMPLE, transport: { type: 'sendmail', command: 'msmtp' } });
  assert.ok(defaults.ok && defaults.value.transport.type === 'sendmail');
  assert.deepEqual(defaults.value.transport.args, ['-t', '-i']);
});

test('limits default to the documented example\'s values, and must be positive', () => {
  const { limits: _, ...noLimits } = EXAMPLE;
  const parsed = parseNotifyConfig(noLimits);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.limits, { perHour: 10, maxBytes: 200000, cooldownMs: 12 * 3_600_000 });
  assert.deepEqual(issues({ ...EXAMPLE, limits: { 'per-hour': 0, cooldown: 'soon' } }), [
    'notify.limits.per-hour: must be a positive whole number',
    'notify.limits.cooldown: must be a duration such as 90s, 30m or 2h',
  ]);
});

test('no notify section means notifications are not configured; unknown keys are problems', () => {
  assert.deepEqual(parseNotifyConfig(undefined), { ok: true, value: undefined });
  assert.deepEqual(issues({ ...EXAMPLE, transport: { ...EXAMPLE.transport, tls: false } }), ['notify.transport.tls: unknown key']);
  assert.deepEqual(issues({ ...EXAMPLE, transport: { type: 'pigeon' } }), ['notify.transport.type: must be one of smtp, sendmail']);
});
