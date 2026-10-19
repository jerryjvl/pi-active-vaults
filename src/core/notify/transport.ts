// Composing a message and handing it to the configured transport
// (notifications.md "Guarantees", "Implementation").
//
// The message is composed once, by nodemailer's MailComposer, as plain UTF-8
// text with file and URL access disabled; the same bytes go to either
// transport, with an explicit envelope: from the configured sender to the
// alias's configured address, and nothing else. So no text in a subject or
// body can become a recipient or a header.
//
// SMTP is nodemailer's, never hand-written: port 465 uses TLS from the start
// (`secure`), port 587 requires STARTTLS (`requireTLS`); certificates are
// always verified and TLS 1.2 is the minimum, so there is no path on which the
// password crosses an unencrypted connection. The password is resolved here,
// at sending, and never leaves this function — not in an argument, a log, or
// an error: failures are reduced to a short reason. `sendmail` passes the
// message to the configured command on standard input, through `process`.

import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Clock } from '../clock/index.ts';
import { resolveSecret, type SecretDeps } from '../config/index.ts';
import { runProcess } from '../process/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { MailAddress, NotifyTransport } from './config.ts';

export interface TransportDeps {
  readonly clock: Clock;
  readonly secrets: SecretDeps;
  /** A sendmail command's whole environment. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Where SMTP connects instead of the configured port, and certificate
   * authorities to trust besides the system's — for tests against a local
   * server. Verification itself is never switched off.
   */
  readonly smtp?: { readonly port?: number; readonly ca?: string; readonly timeoutMs?: number };
}

export interface ComposedMessage {
  readonly from: MailAddress;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** An HTML alternative to the text body. */
  readonly html?: string;
  readonly messageId: string;
  readonly date: Date;
}

/** Why a delivery failed, and whether trying again could help. */
export type DeliveryFailure = { readonly reason: string; readonly retry: boolean };

const DEFAULT_TIMEOUT_MS = 60_000;

async function compose(message: ComposedMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: message.from.name === undefined ? message.from.address : { name: message.from.name, address: message.from.address },
    to: message.to,
    subject: message.subject,
    text: message.body,
    ...(message.html === undefined ? {} : { html: message.html }),
    messageId: message.messageId,
    date: message.date,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}

/** A nodemailer failure as a short reason that names no address and no credential. */
function smtpFailure(error: unknown): DeliveryFailure {
  const { code, responseCode, command } = (error ?? {}) as { code?: string; responseCode?: number; command?: string };
  if (code === 'ETLS' && command === 'STARTTLS') return { reason: 'tls-required', retry: true };
  if (code === 'ETLS' || code === 'ESOCKET') return { reason: 'tls-failed', retry: true };
  if (code === 'EAUTH' || code === 'ENOAUTH') return { reason: 'auth-failed', retry: true };
  if (code === 'ETIMEDOUT') return { reason: 'timed-out', retry: true };
  if (typeof responseCode === 'number') return { reason: `rejected ${responseCode}`, retry: true };
  if (code === 'ECONNECTION' || code === 'EDNS') return { reason: 'unreachable', retry: true };
  return { reason: 'smtp-failed', retry: true };
}

async function sendSmtp(transport: Extract<NotifyTransport, { type: 'smtp' }>, deps: TransportDeps, envelope: { from: string; to: string }, raw: Buffer): Promise<Result<void, DeliveryFailure>> {
  const password = await resolveSecret(transport.password, deps.secrets);
  if (!password.ok) return err({ reason: 'password', retry: true });
  const timeout = deps.smtp?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mailer = createTransport({
    host: transport.host,
    port: deps.smtp?.port ?? transport.port,
    secure: transport.security === 'tls',
    requireTLS: transport.security === 'starttls',
    auth: { user: transport.user, pass: password.value },
    tls: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      servername: transport.host,
      ...(deps.smtp?.ca === undefined ? {} : { ca: deps.smtp.ca }),
    },
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  try {
    await mailer.sendMail({ envelope: { from: envelope.from, to: [envelope.to] }, raw });
    return ok(undefined);
  } catch (error) {
    return err(smtpFailure(error));
  } finally {
    mailer.close();
  }
}

async function sendCommand(transport: Extract<NotifyTransport, { type: 'sendmail' }>, deps: TransportDeps, raw: Buffer): Promise<Result<void, DeliveryFailure>> {
  const ran = await runProcess({
    program: { file: transport.command, args: transport.args },
    env: deps.env,
    input: raw,
    timeoutMs: deps.smtp?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (!ran.ok) return err({ reason: 'cannot-start', retry: true });
  if (ran.value.timedOut) return err({ reason: 'timed-out', retry: true });
  return ran.value.exitCode === 0 ? ok(undefined) : err({ reason: `command-exit ${ran.value.exitCode ?? 'signal'}`, retry: true });
}

/** Composes the message and delivers it to exactly `message.to`. */
export async function deliver(transport: NotifyTransport, deps: TransportDeps, message: ComposedMessage): Promise<Result<void, DeliveryFailure>> {
  const raw = await compose(message);
  return transport.type === 'smtp'
    ? sendSmtp(transport, deps, { from: message.from.address, to: message.to }, raw)
    : sendCommand(transport, deps, raw);
}
