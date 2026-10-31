// `vault signer …` (cli.md "Signer"): CLI-only commands for the signer, which
// runs as a process of its own, so they are not operations of the catalogue.
// Each is a thin step: the key format, the signer and its protocol are the
// core's.
//
//   run      run the signer in the foreground until signalled
//   key      make a new signing key in a new file, and print its public key
//   status   ask the signer whether it answers, and with which key
//
// Installing the signer as a service is the administrator's: it runs as a
// user of its own, which only they can create (signer.md "Setting it up").

import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pingSigner } from '../core/grants/index.ts';
import { newSigningKey } from '../core/signing/index.ts';
import { describeError, loadInstallation } from '../core/operations/index.ts';
import { startSigner } from '../signer/signer.ts';
import type { CliIo } from './run.ts';

const EXIT = { ok: 0, failed: 1, invalid: 2 } as const;
const USAGE = 'Usage: vault signer run | key <file> | status';

export async function runSignerCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const [, command, ...rest] = argv;

  if (command === 'key' && rest.length === 1 && rest[0] !== undefined && rest[0] !== '') {
    const file = isAbsolute(rest[0]) ? rest[0] : resolve(io.cwd, rest[0]);
    const { pem, jwk } = newSigningKey();
    try {
      // A new file only, readable by this user alone: a key is never written over another.
      writeFileSync(file, pem, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      io.write('stderr', code === 'EEXIST' ? `vault signer: ${file} already exists; a key is never written over.\n` : `vault signer: ${file} cannot be written (${code}).\n`);
      return EXIT.failed;
    }
    io.write('stdout', `${JSON.stringify(jwk)}\n`);
    io.write('stderr', `The private key is in ${file}; name it in the signer's config as key: "!cat ${file}".\nThe line above is its public key, for every verifier's trusted keys (each web broker's).\n`);
    return EXIT.ok;
  }
  if ((command !== 'run' && command !== 'status') || rest.length > 0) {
    io.write('stderr', `${USAGE}\n`);
    return EXIT.invalid;
  }

  const installation = loadInstallation(io.host);
  if (!installation.ok) {
    io.write('stderr', `vault: the installation cannot be loaded. ${describeError(installation.error)}\n`);
    return EXIT.failed;
  }
  const { config, paths } = installation.value;

  if (command === 'status') {
    // The daemon's view first: where it asks for grants; else this user's own signer.
    const socket = config.webGrants?.signer ?? config.signer?.socket ?? paths.signerSocket;
    const status = await pingSigner(socket);
    if (!status.ok) {
      io.write('stderr', status.error.reason === 'unreachable' && status.error.detail === 'not-running'
        ? `No signer answers at ${socket}.\n`
        : `The signer at ${socket} did not answer as a signer (${status.error.reason}).\n`);
      return EXIT.failed;
    }
    const web = status.value.wildcardMin === undefined ? 'it makes no web grants' : `web-grant wildcards need ${status.value.wildcardMin} characters`;
    io.write('stdout', `The signer at ${socket} answers: key ${status.value.kid}, ${web} (version ${status.value.version}).\n`);
    return EXIT.ok;
  }

  const signer = await startSigner({ host: io.host, ...io.signer });
  if (!signer.ok) {
    const { error } = signer;
    const why = error.reason === 'not-configured' ? 'the config has no signer section'
      : error.reason === 'no-key' ? `its key cannot be used (${error.detail})`
      : 'detail' in error ? `${error.reason}: ${error.detail}` : error.reason;
    io.write('stderr', `vault signer: it cannot start (${why}).\n`);
    return EXIT.failed;
  }
  io.write('stderr', `vault signer: running at ${signer.value.socket}, signing with key ${signer.value.kid}.\n`);
  await (io.until ?? new Promise<void>(() => {}));
  await signer.value.stop();
  return EXIT.ok;
}
