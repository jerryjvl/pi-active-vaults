// The signer's service (components/signer.md): a process of its own, run as a
// user of its own, that holds the only copy of the signing key and makes
// statements for processes that may not hold it. What it will state is
// decided by the kinds of statement it serves, each in the module that owns
// the purpose (web grants: the grants module); this module is what every kind
// shares — the protocol, the key, and the signer's own view of a vault.
//
// Invariants:
//  - a kind derives what it states from sources the signer reads itself —
//    never from the request, which only says what to state about (a vault, a
//    job, a run). So whoever can reach the socket, the daemon or a process of
//    its user, can get only statements about what an owner already reviewed.
//    A kind that signed what it was handed would make the key worthless;
//  - the signer's view of a vault is its own fetch of `main`, from the address
//    in its own configuration: a forge's protected `main`, or — only when
//    marked `local: true` — a local path no forge protects;
//  - fetches of one vault are made one at a time, since they share a repository;
//  - a refusal is a reason and a sentence, never the key or a secret command's
//    output.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../clock/index.ts';
import { ensurePrivateDir, resolveSecret, type SecretDeps, type SecretRef, type SignerVault } from '../config/index.ts';
import { fetchCommit, initRepository, type Git, type Sha } from '../git/index.ts';
import { err, isRecord, ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { signingKeyFrom, type SigningKey } from './token.ts';

export interface SignerDeps {
  readonly git: Git;
  /** The signer's own store, for kinds that keep records (opened with every kind's schema). */
  readonly store: Store;
  readonly clock: Clock;
  /** Where the signer keeps its own fetch of each vault. */
  readonly repos: string;
  /** The installation that signs: each statement's issuer. */
  readonly issuer: string;
}

export interface SignRefusal {
  readonly reason: string;
  /** What happened, in a sentence for a log or a message. */
  readonly text: string;
}

/** One kind of statement the signer makes. */
export interface StatementKind {
  /** The name a request asks for it by (`params.kind`). */
  readonly name: string;
  /** What a client may want to know of it, in the answer to `ping`. */
  readonly status: Readonly<Record<string, unknown>>;
  /** Makes the statement(s) a request asks for — from the signer's own sources, never from `params` beyond what to state about — or says why not. */
  sign(params: Readonly<Record<string, unknown>>, key: SigningKey): Promise<Result<unknown, SignRefusal>>;
}

/** The signing key a secret reference names, or why it cannot be used. */
export async function signingKeyOf(ref: SecretRef, secrets: SecretDeps): Promise<Result<SigningKey, string>> {
  const pem = await resolveSecret(ref, secrets);
  if (!pem.ok) return err(`${pem.error.where}: ${pem.error.reason}`);
  const key = signingKeyFrom(pem.value);
  return key.ok ? ok(key.value) : err(`${ref.where}: ${key.error.reason}`);
}

const fetching = new Map<string, Promise<unknown>>();

/** Runs `work` after any earlier work on `key` has finished. */
function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = fetching.get(key) ?? Promise.resolve();
  const next = before.then(work, work);
  fetching.set(key, next);
  return next;
}

/** The vault's `main` as its configured address has it now, fetched into the signer's own repository. */
export async function fetchSignerMain(deps: SignerDeps, vault: SignerVault): Promise<Result<{ readonly repo: string; readonly main: Sha }, SignRefusal>> {
  const repo = join(deps.repos, vault.id);
  const failed = err<SignRefusal>({ reason: 'fetch-failed', text: `the signer could not fetch the main of "${vault.id}"` });
  return oneAtATime(repo, async () => {
    if (!existsSync(join(repo, '.git'))) {
      ensurePrivateDir(dirname(repo));
      const made = await initRepository(deps.git, repo, {});
      if (!made.ok) return failed;
    }
    const fetched = await fetchCommit(deps.git, repo, vault.url, 'refs/heads/main');
    return fetched.ok ? ok({ repo, main: fetched.value }) : failed;
  });
}

export type SignerReply = { readonly id: unknown; readonly ok: true; readonly result: unknown } | { readonly id: unknown; readonly ok: false; readonly error: SignRefusal };

/**
 * The answer to one message on the signer's socket (signer.md "Protocol"):
 * `ping` says what it is — version, key and the kinds it serves — `sign`
 * makes the statement its `params.kind` names, and anything else is refused.
 * Undefined for a message that is not a request at all.
 */
export async function answerSignerMessage(
  kinds: readonly StatementKind[], key: SigningKey, version: string, message: unknown,
): Promise<SignerReply | undefined> {
  if (!isRecord(message)) return undefined;
  const { id, method, params } = message;
  if (method === 'ping') {
    return { id, ok: true, result: { version, kid: key.kid, kinds: Object.fromEntries(kinds.map((k) => [k.name, k.status])) } };
  }
  if (method !== 'sign') return { id, ok: false, error: { reason: 'unknown-method', text: 'the signer answers only ping and sign' } };
  const kind = isRecord(params) ? kinds.find((k) => k.name === params['kind']) : undefined;
  if (kind === undefined || !isRecord(params)) return { id, ok: false, error: { reason: 'unknown-kind', text: 'the signer makes no statement of that kind' } };
  const { kind: _, ...rest } = params;
  const signed = await kind.sign(rest, key);
  return signed.ok ? { id, ok: true, result: signed.value } : { id, ok: false, error: signed.error };
}
