// A local SMTP stub with a test certificate, so TLS and STARTTLS enforcement
// are exercised for real. Speaks just enough submission SMTP for one client:
// EHLO, STARTTLS, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, RSET, NOOP, QUIT.
// Records every command and message, and whether the connection was
// encrypted when AUTH arrived. Never touches the network beyond 127.0.0.1.

import { readFileSync } from 'node:fs';
import { createServer as createNetServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { createServer as createTlsServer, TLSSocket, type SecureVersion } from 'node:tls';
import { fileURLToPath } from 'node:url';

const TLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'tls');
/** The test CA that signed the stub's certificate (for `localhost` and 127.0.0.1). */
export const TEST_CA = readFileSync(join(TLS_DIR, 'ca.pem'), 'utf8');
const KEY = readFileSync(join(TLS_DIR, 'server.key'));
const CERT = readFileSync(join(TLS_DIR, 'server.pem'));

export interface SmtpStubOptions {
  /** `tls`: encrypted from the start (port 465); `starttls`: offers STARTTLS; `plain`: never encrypts. */
  readonly mode: 'tls' | 'starttls' | 'plain';
  /** The password AUTH accepts; any other is refused with 535. */
  readonly password: string;
  /** The highest TLS version the stub will speak. */
  readonly maxTlsVersion?: SecureVersion;
  /** Refuse every RCPT with this reply. */
  readonly rejectRecipients?: string;
}

export interface SmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
}

export interface SmtpStub {
  readonly port: number;
  readonly commands: string[];
  readonly logins: { user: string; password: string; encrypted: boolean }[];
  readonly messages: SmtpMessage[];
  close(): Promise<void>;
}

const decode = (text: string): string => Buffer.from(text, 'base64').toString('utf8');

export async function startSmtpStub(options: SmtpStubOptions): Promise<SmtpStub> {
  const commands: string[] = [];
  const logins: SmtpStub['logins'] = [];
  const messages: SmtpMessage[] = [];
  const sockets = new Set<Socket>();
  const tlsOptions = { key: KEY, cert: CERT, ...(options.maxTlsVersion === undefined ? {} : { maxVersion: options.maxTlsVersion }) };

  /** One connection; `greet` is false after STARTTLS, where the client speaks first. */
  function converse(socket: Socket, encrypted: boolean, greet: boolean): void {
    let buffer = '';
    let data: string[] | undefined;
    let pendingAuth: { step: 'plain' } | { step: 'user' } | { step: 'pass'; user: string } | undefined;
    let envelope: { from: string; to: string[] } = { from: '', to: [] };
    const reply = (line: string): void => { socket.write(`${line}\r\n`); };

    const login = (user: string, password: string): void => {
      logins.push({ user, password, encrypted });
      reply(password === options.password ? '235 2.7.0 Authenticated' : '535 5.7.8 Authentication failed');
    };

    const onLine = (line: string): void => {
      if (data !== undefined) {
        if (line === '.') {
          messages.push({ ...envelope, data: data.join('\r\n') });
          data = undefined;
          envelope = { from: '', to: [] };
          reply('250 2.0.0 Queued');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        return;
      }
      if (pendingAuth !== undefined) {
        const step = pendingAuth;
        pendingAuth = undefined;
        if (step.step === 'plain') {
          const [, user = '', password = ''] = decode(line).split('\0');
          login(user, password);
        } else if (step.step === 'user') {
          pendingAuth = { step: 'pass', user: decode(line) };
          reply('334 UGFzc3dvcmQ6');
        } else {
          login(step.user, decode(line));
        }
        return;
      }
      commands.push(line.startsWith('AUTH') ? line.split(' ').slice(0, 2).join(' ') : line);
      const verb = line.split(' ')[0]?.toUpperCase() ?? '';
      switch (verb) {
        case 'EHLO':
        case 'HELO': {
          const extensions = [...(options.mode === 'starttls' && !encrypted ? ['STARTTLS'] : []), 'AUTH PLAIN LOGIN', '8BITMIME', 'SMTPUTF8'];
          [`localhost`, ...extensions].forEach((e, i, all) => reply(`250${i === all.length - 1 ? ' ' : '-'}${e}`));
          return;
        }
        case 'STARTTLS': {
          if (options.mode !== 'starttls' || encrypted) return reply('502 5.5.1 Not offered');
          reply('220 2.0.0 Ready to start TLS');
          socket.removeAllListeners('data');
          const secured = new TLSSocket(socket, { isServer: true, ...tlsOptions });
          secured.on('error', () => secured.destroy());
          sockets.add(secured);
          converse(secured, true, false);
          return;
        }
        case 'AUTH': {
          const [, method = '', initial] = line.split(' ');
          if (method.toUpperCase() === 'PLAIN') {
            if (initial === undefined) {
              pendingAuth = { step: 'plain' };
              return reply('334 ');
            }
            const [, user = '', password = ''] = decode(initial).split('\0');
            return login(user, password);
          }
          if (method.toUpperCase() === 'LOGIN') {
            if (initial === undefined) {
              pendingAuth = { step: 'user' };
              return reply('334 VXNlcm5hbWU6');
            }
            pendingAuth = { step: 'pass', user: decode(initial) };
            return reply('334 UGFzc3dvcmQ6');
          }
          return reply('504 5.5.4 Unknown method');
        }
        case 'MAIL':
          envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          return reply('250 2.1.0 OK');
        case 'RCPT':
          if (options.rejectRecipients !== undefined) return reply(options.rejectRecipients);
          envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          return reply('250 2.1.5 OK');
        case 'DATA':
          data = [];
          return reply('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          envelope = { from: '', to: [] };
          return reply('250 2.0.0 OK');
        case 'NOOP':
          return reply('250 2.0.0 OK');
        case 'QUIT':
          reply('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          return reply('502 5.5.2 Unknown command');
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        onLine(line);
      }
    });
    socket.on('error', () => socket.destroy());
    if (greet) reply('220 localhost ESMTP stub');
  }

  const server: Server = options.mode === 'tls'
    ? createTlsServer(tlsOptions, (socket) => { sockets.add(socket); converse(socket, true, true); })
    : createNetServer((socket) => { sockets.add(socket); converse(socket, false, true); });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    commands,
    logins,
    messages,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
