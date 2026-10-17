// Documented behaviour: notifications.md — messages go only to configured
// aliases; text in a subject or body cannot add or change a recipient; SMTP is
// encrypted before authentication (465: TLS from the start; 587: STARTTLS,
// required), certificates are verified and TLS 1.2 is the minimum, with no
// plaintext fallback; the password is resolved at sending and never recorded;
// each message is in the outbox before sending and marked sent only once the
// server accepts it; failures are retried with backoff; the Message-ID derives
// from the trace and key, so a retry is the same message; a key deduplicates
// within its cooldown; per-hour and size limits apply. Local stubs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { SecretDeps } from '../../../src/core/config/index.ts';
import {
  deliverDue,
  notifySchema,
  parseNotifyConfig,
  sendNotification,
  testTransport,
  undeliveredNotifications,
  type NotifyConfig,
  type NotifyDeps,
} from '../../../src/core/notify/index.ts';
import type { Store } from '../../../src/core/store/index.ts';
import { fakeClock, type FakeClock } from '../../support/clock.ts';
import { TEST_CA, startSmtpStub, type SmtpStub, type SmtpStubOptions } from '../../support/smtp-server.ts';
import { withStore } from '../../support/store.ts';

const PASSWORD = 'app-specific-password';
const TRACE = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const secrets: SecretDeps = { env: { SMTP_PASSWORD: PASSWORD }, runCommand: async () => assert.fail('no command') };

function config(port: 465 | 587, extra: Record<string, unknown> = {}): NotifyConfig {
  const parsed = parseNotifyConfig({
    from: 'Vault <vault@example.net>',
    recipients: { me: 'me@example.net', partner: 'partner@example.org' },
    transport: { type: 'smtp', host: '127.0.0.1', port, user: 'vault@example.net', password: '${SMTP_PASSWORD}' },
    ...extra,
  });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.ok(parsed.value !== undefined);
  return parsed.value;
}

async function withSmtp(options: Omit<SmtpStubOptions, 'password'>, run: (stub: SmtpStub) => Promise<void>): Promise<void> {
  const stub = await startSmtpStub({ password: PASSWORD, ...options });
  try {
    await run(stub);
  } finally {
    await stub.close();
  }
}

function deps(store: Store, clock: FakeClock, notify: NotifyConfig, stub: SmtpStub | undefined, overrides: Partial<NotifyDeps> = {}): NotifyDeps {
  return { store, config: notify, clock, secrets, env: {}, smtp: { ...(stub === undefined ? {} : { port: stub.port }), ca: TEST_CA, timeoutMs: 5000 }, ...overrides };
}

const send = (d: NotifyDeps, fields: Partial<Parameters<typeof sendNotification>[1]> = {}) =>
  sendNotification(d, { to: 'me', subject: 'Digest ready', body: 'Hello.\n', trace: TRACE, ...fields });

const headerOf = (data: string, name: string): string | undefined =>
  data.split('\r\n\r\n')[0]?.split('\r\n').find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();

test('port 465 sends over TLS from the start, authenticated, to the alias\'s address only', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const sent = await send(deps(store, clock, config(465), stub), { key: 'digest-2026-01-01' });
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.equal(sent.value.outcome, 'sent');
    assert.deepEqual(stub.logins, [{ user: 'vault@example.net', password: PASSWORD, encrypted: true }]);
    assert.equal(stub.messages.length, 1);
    const [message] = stub.messages;
    assert.deepEqual([message?.from, message?.to], ['vault@example.net', ['me@example.net']]);
    assert.equal(headerOf(message?.data ?? '', 'To'), 'me@example.net');
    assert.equal(headerOf(message?.data ?? '', 'Message-ID'), sent.value.messageId);
    assert.match(sent.value.messageId, new RegExp(`^<${TRACE}\\.[0-9a-f]{16}@example\\.net>$`));
    assert.deepEqual(Object.keys(sent.value).sort(), ['alias', 'messageId', 'outcome', 'subject'], 'the record holds no address or credential');
    assert.deepEqual(undeliveredNotifications(store), []);
  });
}));

test('port 587 authenticates only after STARTTLS, and a server that does not offer it gets nothing — no fallback', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'starttls' }, async (stub) => {
    assert.equal((await send(deps(store, clock, config(587), stub))).ok && stub.logins[0]?.encrypted, true);
  });
  await withSmtp({ mode: 'plain' }, async (stub) => {
    const sent = await send(deps(store, clock, config(587), stub));
    assert.ok(sent.ok);
    assert.equal(sent.value.outcome, 'queued', 'kept for retry, not sent in the clear');
    assert.deepEqual(stub.logins, []);
    assert.ok(!stub.commands.some((c) => c.startsWith('MAIL') || c.startsWith('AUTH')));
    assert.equal(undeliveredNotifications(store)[0]?.lastError, 'tls-required');
  });
}));

test('a certificate that is not trusted, or TLS older than 1.2, fails before anything is sent', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const untrusted = await send(deps(store, clock, config(465), stub, { smtp: { port: stub.port, timeoutMs: 5000 } }));
    assert.ok(untrusted.ok && untrusted.value.outcome === 'queued');
    assert.deepEqual([stub.logins, stub.messages], [[], []]);
  });
  await withSmtp({ mode: 'tls', maxTlsVersion: 'TLSv1.1' }, async (stub) => {
    const old = await send(deps(store, clock, config(465), stub));
    assert.ok(old.ok && old.value.outcome === 'queued');
    assert.deepEqual([stub.logins, stub.messages], [[], []]);
  });
  assert.deepEqual(undeliveredNotifications(store).map((n) => n.lastError), ['tls-failed', 'tls-failed']);
}));

test('only a configured alias is a recipient: a raw address or an unknown alias is refused and nothing is queued', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const d = deps(store, clock, config(465), stub);
    assert.deepEqual(await send(d, { to: 'me@example.net' }), { ok: false, error: { reason: 'raw-address' } });
    assert.deepEqual(await send(d, { to: 'stranger' }), { ok: false, error: { reason: 'unknown-recipient', alias: 'stranger' } });
    assert.deepEqual(stub.messages, []);
    assert.deepEqual(store.all('SELECT * FROM notify_outbox'), []);
  });
}));

test('a subject or body cannot add or change a recipient; line breaks leave the subject', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const sent = await send(deps(store, clock, config(465), stub), {
      subject: 'Hello\r\nBcc: evil@example.com',
      body: 'Body\r\nBcc: evil@example.com\r\n.\r\nRCPT TO:<evil@example.com>\r\n',
    });
    assert.ok(sent.ok && sent.value.outcome === 'sent');
    assert.equal(sent.value.subject, 'Hello Bcc: evil@example.com');
    const [message] = stub.messages;
    assert.deepEqual(message?.to, ['me@example.net']);
    assert.equal(headerOf(message?.data ?? '', 'Bcc'), undefined);
    assert.equal(headerOf(message?.data ?? '', 'Subject'), 'Hello Bcc: evil@example.com');
  });
}));

test('a key drops a second message inside its cooldown, and allows it after', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const d = deps(store, clock, config(465, { limits: { cooldown: '1h' } }), stub);
    assert.equal((await send(d, { key: 'k' })).ok, true);
    clock.advance(59 * 60_000);
    const again = await send(d, { key: 'k' });
    assert.ok(again.ok && again.value.outcome === 'duplicate');
    assert.ok((await send(d, { key: 'other' })).ok);
    clock.advance(2 * 60_000);
    const later = await send(d, { key: 'k' });
    assert.ok(later.ok && later.value.outcome === 'sent');
    assert.equal(stub.messages.length, 3);
  });
}));

test('volume is bounded: per hour, and by size', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const d = deps(store, clock, config(465, { limits: { 'per-hour': 2, 'max-bytes': 100 } }), stub);
    assert.deepEqual(await send(d, { body: 'x'.repeat(101) }), { ok: false, error: { reason: 'too-large', maxBytes: 100 } });
    assert.ok((await send(d)).ok);
    assert.ok((await send(d)).ok);
    assert.deepEqual(await send(d), { ok: false, error: { reason: 'rate-limited', perHour: 2 } });
    clock.advance(60 * 60_000 + 1);
    assert.ok((await send(d)).ok);
    assert.equal(stub.messages.length, 3);
  });
}));

test('a failed send stays in the outbox and is retried with backoff as the same message; the password is never stored', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  let messageId = '';
  await withSmtp({ mode: 'tls', rejectRecipients: '451 4.3.0 Try again later' }, async (stub) => {
    const first = await send(deps(store, clock, config(465), stub), { key: 'k' });
    assert.ok(first.ok && first.value.outcome === 'queued');
    messageId = first.value.messageId;
    const [pending] = undeliveredNotifications(store);
    assert.deepEqual([pending?.attempts, pending?.lastError, pending?.nextAttempt], [1, 'rejected 451', '2026-01-01T00:01:00.000Z']);
  });
  await withSmtp({ mode: 'tls' }, async (stub) => {
    assert.deepEqual(await deliverDue(deps(store, clock, config(465), stub)), [], 'not yet due');
    clock.advance(60_000);
    const retried = await deliverDue(deps(store, clock, config(465), stub));
    assert.deepEqual(retried.map((r) => [r.outcome, r.messageId]), [['sent', messageId]]);
    assert.equal(headerOf(stub.messages[0]?.data ?? '', 'Message-ID'), messageId);
    assert.deepEqual(undeliveredNotifications(store), []);
  });
  assert.ok(!JSON.stringify(store.all('SELECT * FROM notify_outbox')).includes(PASSWORD));
}));

test('a message whose alias was removed before its retry is undeliverable, and says so', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'plain' }, async (stub) => {
    assert.ok((await send(deps(store, clock, config(587), stub), { to: 'partner' })).ok);
  });
  clock.advance(60 * 60_000);
  const without = parseNotifyConfig({ from: 'vault@example.net', recipients: { me: 'me@example.net' }, transport: { type: 'sendmail', command: '/bin/false' } });
  assert.ok(without.ok && without.value !== undefined);
  const results = await deliverDue(deps(store, clock, without.value, undefined));
  assert.deepEqual(results.map((r) => [r.alias, r.outcome]), [['partner', 'undeliverable']]);
  assert.equal(undeliveredNotifications(store)[0]?.lastError, 'unknown-recipient');
  assert.deepEqual(await deliverDue(deps(store, clock, without.value, undefined)), [], 'not tried again');
}));

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX sh' : false };

test('the sendmail transport passes the message to the configured command on standard input', posixOnly, withStore([notifySchema], async (store, dir) => {
  const clock = fakeClock();
  const out = dir.file('mail.txt');
  const script = dir.file('fake-sendmail.sh');
  writeFileSync(script, `#!/bin/sh\necho "$@" > "${out}.args"\ncat > "${out}"\n`, { mode: 0o700 });
  const parsed = parseNotifyConfig({ from: 'vault@example.net', recipients: { me: 'me@example.net' }, transport: { type: 'sendmail', command: script } });
  assert.ok(parsed.ok && parsed.value !== undefined);
  const sent = await send(deps(store, clock, parsed.value, undefined, { env: { PATH: '/usr/bin:/bin' } }));
  assert.ok(sent.ok && sent.value.outcome === 'sent', JSON.stringify(sent));
  const mail = readFileSync(out, 'utf8');
  assert.equal(headerOf(mail.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'), 'To'), 'me@example.net');
  assert.match(mail, /Hello\./);
  assert.equal(readFileSync(`${out}.args`, 'utf8').trim(), '-t -i');

  writeFileSync(script, '#!/bin/sh\ncat > /dev/null\nexit 75\n', { mode: 0o700 });
  const failed = await send(deps(store, clock, parsed.value, undefined, { env: { PATH: '/usr/bin:/bin' } }));
  assert.ok(failed.ok && failed.value.outcome === 'queued');
  assert.equal(undeliveredNotifications(store)[0]?.lastError, 'command-exit 75');
}));

test('a transport test delivers one message to an alias directly, keeps nothing in the outbox, and reports why it failed', withStore([notifySchema], async (store) => {
  const clock = fakeClock();
  await withSmtp({ mode: 'tls' }, async (stub) => {
    const tested = await testTransport(deps(store, clock, config(465), stub), 'partner');
    assert.deepEqual(tested, { ok: true, value: undefined });
    assert.deepEqual(stub.messages.map((m) => m.to), [['partner@example.org']]);
    assert.equal(undeliveredNotifications(store).length, 0);
    assert.equal(store.get<{ n: number }>('SELECT count(*) AS n FROM notify_outbox')?.n, 0);
    assert.deepEqual(await testTransport(deps(store, clock, config(465), stub), 'partner@example.org'), { ok: false, error: { reason: 'raw-address' } });
    assert.deepEqual(await testTransport(deps(store, clock, config(465), stub), 'nobody'), { ok: false, error: { reason: 'unknown-recipient', alias: 'nobody' } });
  });
  const unreachable = await testTransport(deps(store, clock, config(465), undefined, { smtp: { port: 1, ca: TEST_CA, timeoutMs: 2000 } }), 'me');
  assert.deepEqual(unreachable, { ok: false, error: { reason: 'delivery-failed', failure: 'unreachable' } });
}));
