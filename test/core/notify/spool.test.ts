// Documented behaviour: notifications.md "Spools" — a drop directory per
// recipient alias; a message there names no recipient, so it reaches only that
// alias; headers Subject (required), Key and Format, then a blank line and the
// body; a name starting with "." is not a message (written, then renamed into
// place); a valid message goes through the outbox like any other and is
// removed; an invalid one is renamed `.rejected-<name>` and never retried; a
// spool sends at most half the hour's notifications, the rest waiting for the
// next pass. The config names only configured aliases and absolute paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  drainSpool,
  notifySchema,
  parseNotifyConfig,
  parseSpoolMessage,
  spoolAllowance,
  type NotifyConfig,
  type NotifyDeps,
} from '../../../src/core/notify/index.ts';
import type { Store } from '../../../src/core/store/index.ts';
import { fakeClock } from '../../support/clock.ts';
import { withStore } from '../../support/store.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX sh as sendmail' : false };

/** A config whose transport is a fake sendmail that keeps each message as a file in `mail`. */
function setup(store: Store, dir: { file(name: string): string }, limits?: Record<string, unknown>): { deps: NotifyDeps; spool: string; mail: string } {
  const mail = dir.file('mail');
  const spool = dir.file('spool');
  mkdirSync(mail);
  mkdirSync(spool);
  const script = dir.file('fake-sendmail.sh');
  writeFileSync(script, `#!/bin/sh\ncat > "${mail}/$(date +%s%N)-$$"\n`, { mode: 0o700 });
  const parsed = parseNotifyConfig({
    from: 'vault@example.net', recipients: { me: 'me@example.net', partner: 'partner@example.org' },
    transport: { type: 'sendmail', command: script }, spools: { me: spool }, ...(limits === undefined ? {} : { limits }),
  });
  assert.ok(parsed.ok && parsed.value !== undefined, JSON.stringify(parsed));
  return { deps: { store, config: parsed.value, clock: fakeClock(), secrets: { env: {}, runCommand: async () => assert.fail('no command') }, env: { PATH: '/usr/bin:/bin' } }, spool, mail };
}

const mails = (mail: string): string[] => readdirSync(mail).sort().map((f) => readFileSync(join(mail, f), 'utf8'));
let traces = 0;
const trace = () => `01TRACE${String(++traces).padStart(19, '0')}`;

test('a spool message: headers, a blank line, the body; Subject is required, other headers known ones only', () => {
  assert.deepEqual(parseSpoolMessage('Subject: Blocked fetch\nKey: web-mcp:card\n\nA card number was refused.\n'),
    { ok: true, value: { subject: 'Blocked fetch', key: 'web-mcp:card', format: 'plain', body: 'A card number was refused.\n' } });
  const md = parseSpoolMessage('Subject: x\nFormat: markdown\n\n# Hi');
  assert.ok(md.ok && md.value.format === 'markdown');
  for (const [text, why] of [
    ['Key: k\n\nbody', /no Subject/],
    ['Subject: x\nTo: someone@example.net\n\nbody', /unknown header "To"/],
    ['Subject: x\nSubject: y\n\nbody', /given twice/],
    ['Subject: x\nKey: has spaces\n\nbody', /Key header/],
    ['Subject: x\nFormat: html\n\nbody', /Format header/],
    ['Subject: x\nnot a header\n\nbody', /not a header/],
  ] as const) {
    const parsed = parseSpoolMessage(text);
    assert.ok(!parsed.ok);
    assert.match(parsed.error, why);
  }
});

test('the config names configured aliases and absolute directories, one alias per directory', () => {
  const base = { from: 'vault@example.net', recipients: { me: 'me@example.net', you: 'you@example.net' }, transport: { type: 'sendmail', command: '/usr/sbin/sendmail' } };
  const read = (spools: unknown) => parseNotifyConfig({ ...base, spools });
  const good = read({ me: '/var/spool/pav/me' });
  assert.ok(good.ok && good.value !== undefined);
  assert.deepEqual((good.value as NotifyConfig).spools, { me: '/var/spool/pav/me' });
  const none = parseNotifyConfig(base);
  assert.ok(none.ok && none.value !== undefined && Object.keys(none.value.spools).length === 0);
  for (const [spools, where, what] of [
    [{ stranger: '/var/spool/pav/x' }, 'notify.spools.stranger', /an alias from notify.recipients/],
    [{ me: 'relative/dir' }, 'notify.spools.me', /absolute directory/],
    [{ me: '/var/spool/pav', you: '/var/spool/pav' }, 'notify.spools.you', /another alias/],
  ] as const) {
    const parsed = read(spools);
    assert.ok(!parsed.ok);
    assert.ok(parsed.error.some((i) => i.path === where && what.test(i.message)), JSON.stringify(parsed.error));
  }
});

test('a valid message goes to the spool\'s alias, and only it, through the outbox; it is then removed; dot-names wait', posixOnly, withStore([notifySchema], async (store, dir) => {
  const { deps, spool, mail } = setup(store, dir);
  writeFileSync(join(spool, 'a'), 'Subject: Blocked fetch\nKey: web-mcp:card\n\nTo: partner@example.org\nA card number was refused.\n');
  writeFileSync(join(spool, '.partial'), 'Subject: half-written\n');
  const pass = await drainSpool(deps, 'me', spool, trace, 5);
  assert.deepEqual(pass.sent.map((s) => [s.file, s.outcome, s.alias]), [['a', 'sent', 'me']]);
  assert.deepEqual(readdirSync(spool), ['.partial'], 'sent and removed; the dot-name is not a message yet');
  const [message = ''] = mails(mail);
  const headers = message.split(/\r?\n\r?\n/)[0] ?? '';
  assert.match(headers, /^To: me@example\.net\r?$/m, 'the spool\'s alias');
  assert.doesNotMatch(headers, /partner/, 'text in the body names no recipient');

  writeFileSync(join(spool, 'b'), 'Subject: Blocked fetch again\nKey: web-mcp:card\n\nRefused again.\n');
  const again = await drainSpool(deps, 'me', spool, trace, 5);
  assert.deepEqual(again.sent.map((s) => s.outcome), ['duplicate'], 'the key deduplicates within its cooldown');
  assert.deepEqual(readdirSync(spool), ['.partial']);
  assert.equal(mails(mail).length, 1);
}));

test('a Markdown message gets its HTML alternative', posixOnly, withStore([notifySchema], async (store, dir) => {
  const { deps, spool, mail } = setup(store, dir);
  writeFileSync(join(spool, 'md'), 'Subject: Report\nFormat: markdown\n\n# Heading\n\n**bold**\n');
  await drainSpool(deps, 'me', spool, trace, 5);
  assert.match(mails(mail)[0] ?? '', /text\/html/);
}));

test('an invalid message is renamed .rejected-<name> with why, never retried; the rest still go', posixOnly, withStore([notifySchema], async (store, dir) => {
  const { deps, spool, mail } = setup(store, dir, { 'max-bytes': 100 });
  writeFileSync(join(spool, '1-bad'), 'no headers at all\n');
  writeFileSync(join(spool, '2-big'), `Subject: big\n\n${'x'.repeat(5000)}\n`);
  writeFileSync(join(spool, '3-binary'), Buffer.from([0x53, 0x75, 0x62, 0x6a, 0xff, 0xfe, 0x0a]));
  symlinkSync('/etc/hostname', join(spool, '4-link'));
  writeFileSync(join(spool, '5-good'), 'Subject: fine\n\nok\n');
  const pass = await drainSpool(deps, 'me', spool, trace, 5);
  assert.deepEqual(pass.rejected.map((r) => r.file), ['1-bad', '2-big', '3-binary', '4-link'].filter((f) => pass.rejected.some((r) => r.file === f)));
  assert.equal(pass.rejected.length, 4);
  assert.match(pass.rejected.find((r) => r.file === '2-big')?.why ?? '', /body limit/);
  assert.match(pass.rejected.find((r) => r.file === '3-binary')?.why ?? '', /UTF-8/);
  assert.match(pass.rejected.find((r) => r.file === '4-link')?.why ?? '', /regular file/);
  assert.deepEqual(pass.sent.map((s) => s.file), ['5-good']);
  assert.deepEqual(readdirSync(spool).sort(), ['.rejected-1-bad', '.rejected-2-big', '.rejected-3-binary', '.rejected-4-link']);
  assert.equal(mails(mail).length, 1);
  const next = await drainSpool(deps, 'me', spool, trace, 5);
  assert.deepEqual([next.sent.length, next.rejected.length], [0, 0], 'rejected messages are not tried again');
}));

test('a spool sends at most its allowance — half the hour\'s limit — and the rest wait for the next pass', posixOnly, withStore([notifySchema], async (store, dir) => {
  const { deps, spool, mail } = setup(store, dir, { 'per-hour': 4 });
  assert.equal(spoolAllowance(4), 2);
  assert.equal(spoolAllowance(1), 1, 'never none');
  for (const n of [1, 2, 3]) writeFileSync(join(spool, `m${n}`), `Subject: alert ${n}\n\nbody\n`);
  const pass = await drainSpool(deps, 'me', spool, trace, spoolAllowance(4));
  assert.deepEqual([pass.sent.length, pass.waiting], [2, 1]);
  assert.deepEqual(readdirSync(spool), ['m3'], 'the oldest went first; the last waits');
  assert.equal(mails(mail).length, 2);
}));

test('a message the daemon cannot read (not group-readable) is rejected and says so', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX modes, not as root' : false }, withStore([notifySchema], async (store, dir) => {
  const { deps, spool } = setup(store, dir);
  writeFileSync(join(spool, 'private'), 'Subject: x\n\nbody\n', { mode: 0o000 });
  const pass = await drainSpool(deps, 'me', spool, trace, 5);
  assert.match(pass.rejected[0]?.why ?? '', /not readable by the daemon/);
  assert.deepEqual(readdirSync(spool), ['.rejected-private']);
}));
