// The signer (components/signer.md): a thin adapter that runs, as a user of
// its own, the core's signing service — it holds the signing key so that
// neither the daemon nor the sessions it starts can read it, and makes the
// kinds of statement the core lists (`signerKinds`: web grants, so far).
//
//  - it starts only with a `signer` section and a key it can use, so a
//    misconfigured signer does not run rather than refusing every request;
//    the key is read once, at start, and kept only in this process;
//  - it listens on its socket (the configured one, else the default in its
//    state directory), for its user only or, with `socket-access: group`, for
//    its group too, so a daemon running as another user in that group can ask;
//  - each message is answered by the core (`answerSignerMessage`): what is
//    stated is decided there, by each kind, from sources the signer reads
//    itself — never from the request;
//  - each statement made or refused is one line on standard error, for the
//    service's log: its kind and what it was about, never the statement or the key.

import { packageVersion, systemSecretDeps, type Host, type SecretDeps } from '../core/config/index.ts';
import { systemClock, type Clock } from '../core/clock/index.ts';
import { createGit, type Git } from '../core/git/index.ts';
import { loadInstallation, openSignerStore, signerKinds } from '../core/operations/index.ts';
import { err, isRecord, ok, type Result } from '../core/result/index.ts';
import { answerSignerMessage, signingKeyOf, type SignerDeps } from '../core/signing/index.ts';
import { listenSocket, type ListenError } from '../core/socket/index.ts';

export interface SignerOptions {
  readonly host: Host;
  /** Services to use instead of the system's (tests). */
  readonly git?: Git;
  readonly clock?: Clock;
  readonly secrets?: SecretDeps;
  /** Where each grant's line goes (default: standard error). */
  readonly log?: (line: string) => void;
}

export interface RunningSigner {
  readonly socket: string;
  /** The ID of the key it signs with. */
  readonly kid: string;
  stop(): Promise<void>;
}

export type SignerStartError =
  | { readonly reason: 'installation'; readonly detail: string }
  | { readonly reason: 'not-configured' }
  | { readonly reason: 'no-key'; readonly detail: string }
  | { readonly reason: 'store'; readonly detail: string }
  | ListenError;

/** Starts the signer; it runs until `stop`. */
export async function startSigner(options: SignerOptions): Promise<Result<RunningSigner, SignerStartError>> {
  const installation = loadInstallation(options.host);
  if (!installation.ok) return err({ reason: 'installation', detail: installation.error.reason });
  const { config: { signer: config, name }, paths } = installation.value;
  if (config === undefined) return err({ reason: 'not-configured' });
  const secrets = options.secrets ?? systemSecretDeps(options.host.env);
  const key = await signingKeyOf(config.key, secrets);
  if (!key.ok) return err({ reason: 'no-key', detail: key.error });
  const store = openSignerStore(paths);
  if (!store.ok) return err({ reason: 'store', detail: store.error.reason });
  const deps: SignerDeps = {
    git: options.git ?? createGit({ env: options.host.env as NodeJS.ProcessEnv }), store: store.value, clock: options.clock ?? systemClock,
    repos: paths.signerRepos, issuer: name,
  };
  const kinds = signerKinds(deps, config);
  const version = packageVersion();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const socket = config.socket ?? paths.signerSocket;
  const server = await listenSocket(socket, (channel) => {
    channel.onMessage((message) => {
      void answerSignerMessage(kinds, key.value, version, message).then((reply) => {
        if (reply === undefined) return;
        channel.send(reply);
        if (isRecord(message) && message['method'] === 'sign') {
          // What it was about, by the request's own scalar fields: a kind's request names things, it carries no content.
          const params = isRecord(message['params']) ? message['params'] : {};
          const what = Object.entries(params).filter(([, v]) => typeof v === 'string' && v.length <= 200).map(([k, v]) => `${k}=${String(v)}`).join(' ');
          log(reply.ok ? `vault signer: signed ${what}` : `vault signer: refused ${what}: ${reply.error.text}`);
        }
      });
    });
  }, config.socketAccess);
  if (!server.ok) {
    store.value.close();
    return server;
  }
  return ok({
    socket, kid: key.value.kid,
    async stop() {
      await server.value.close();
      store.value.close();
    },
  });
}
