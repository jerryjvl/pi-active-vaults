// Talking to other repositories: fetching and pushing, for templates and
// forges.
//
// Invariants:
//  - a remote is a configured remote's name, or an https, ssh (also
//    `user@host:path`) or local URL. Transports that run commands (`ext::`,
//    `fd::`) or carry no integrity (`http://`, `git://`) are refused here,
//    and again through git's own protocol allow-list, because what is fetched
//    may become a vault's scripts;
//  - fetched objects are checked as they arrive (`fetch.fsckObjects`);
//  - a refspec names full refs on both sides, optionally forced with `+`, so
//    nothing is pushed or fetched by a guess at what a short name means; both
//    sides may end in `/*` together, to fetch whatever lies under a prefix;
//  - credentials are the user's own Git setup's; git never prompts.

import { err, ok, type Result } from '../result/index.ts';
import { configValue } from './config.ts';
import { runForSuccess, runForText, type Git, type GitError } from './exec.ts';
import { resolveRevision, type Sha } from './refs.ts';
import { checkRefName, checkRevision, checkSha, isSha } from './validate.ts';

const PROTOCOLS = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.file.allow=always',
  '-c', 'fetch.fsckObjects=true',
  '-c', 'transfer.fsckObjects=true',
];

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_SCHEMES = /^(?:https|ssh|file):\/\/[^\s]+$/;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/;
const LOCAL_PATH = /^(?:\/|[A-Za-z]:[\\/])[^\s]*$/;

const invalid = (argument: string): Result<never, GitError> => err({ reason: 'invalid-argument', argument });

/** A remote this module will talk to; anything else is refused before git runs. */
export function checkRemote(value: string): Result<string, GitError> {
  if (value === '' || value.startsWith('-') || value.includes('::') || /[\s\0]/.test(value)) return invalid('remote');
  return REMOTE_NAME.test(value) || URL_SCHEMES.test(value) || SCP_LIKE.test(value) || LOCAL_PATH.test(value) ? ok(value) : invalid('remote');
}

/** `[+]refs/…:refs/…`, or `[+]refs/…/*:refs/…/*`. */
function checkRefspec(value: string): Result<string, GitError> {
  const [source = '', destination, ...rest] = value.replace(/^\+/, '').split(':');
  if (destination === undefined || rest.length > 0) return invalid('refspec');
  const glob = source.endsWith('/*') && destination.endsWith('/*');
  // A glob's prefix must itself be a ref name once something is put under it.
  const name = (side: string): string => (glob ? `${side.slice(0, -2)}/x` : side);
  return checkRefName(name(source)).ok && checkRefName(name(destination)).ok ? ok(value) : invalid('refspec');
}

function checkAll(remote: string, refspecs: readonly string[]): Result<void, GitError> {
  const checked = checkRemote(remote);
  if (!checked.ok) return checked;
  for (const refspec of refspecs) {
    const spec = checkRefspec(refspec);
    if (!spec.ok) return spec;
  }
  return refspecs.length === 0 ? invalid('refspec') : ok(undefined);
}

export async function fetchRefs(git: Git, repo: string, remote: string, refspecs: readonly string[]): Promise<Result<void, GitError>> {
  const checked = checkAll(remote, refspecs);
  if (!checked.ok) return checked;
  return runForSuccess(git, [...PROTOCOLS, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', remote, ...refspecs], { cwd: repo });
}

/** A lease: the push may replace `ref` on the remote, but only while it still holds exactly `sha`. */
export interface Lease {
  readonly ref: string;
  readonly sha: Sha;
}

/**
 * Pushes the refspecs. Nothing is forced unless a `lease` is given: then the
 * ref it names — which must be pushed by one of the refspecs — may be replaced
 * with a commit that is not a fast-forward, and only if the remote still
 * holds the leased commit (`--force-with-lease`, with the commit named, so
 * what the remote held when it was last fetched does not matter).
 */
export async function pushRefs(
  git: Git, repo: string, remote: string, refspecs: readonly string[], options: { readonly lease?: Lease } = {},
): Promise<Result<void, GitError>> {
  const checked = checkAll(remote, refspecs);
  if (!checked.ok) return checked;
  const lease: string[] = [];
  if (options.lease !== undefined) {
    const { ref, sha } = options.lease;
    const refOk = checkRefName(ref);
    if (!refOk.ok) return refOk;
    const shaOk = checkSha(sha);
    if (!shaOk.ok) return shaOk;
    if (!refspecs.some((r) => r.startsWith(`${ref}:`))) return invalid('lease');
    lease.push(`--force-with-lease=${ref}:${sha}`);
  }
  return runForSuccess(git, [...PROTOCOLS, 'push', '--quiet', '--no-verify', '--porcelain', ...lease, '--', remote, ...refspecs], { cwd: repo });
}

/** The commit a ref names on the remote, or undefined when the remote has no such ref. */
export async function remoteRef(git: Git, repo: string, remote: string, ref: string): Promise<Result<Sha | undefined, GitError>> {
  const checkedRemote = checkRemote(remote);
  if (!checkedRemote.ok) return checkedRemote;
  const checkedRef = checkRefName(ref);
  if (!checkedRef.ok) return checkedRef;
  const listed = await runForText(git, [...PROTOCOLS, 'ls-remote', '--', remote, ref], { cwd: repo });
  if (!listed.ok) return listed;
  const line = listed.value.split('\n').find((l) => l.endsWith(`\t${ref}`));
  const sha = line?.split('\t')[0];
  return ok(sha === undefined || !isSha(sha) ? undefined : sha);
}

/** Fetches just the commit `ref` names (default: the remote's HEAD), without history, and returns its SHA. */
export async function fetchCommit(git: Git, repo: string, remote: string, ref?: string): Promise<Result<Sha, GitError>> {
  const checked = checkRemote(remote);
  if (!checked.ok) return checked;
  if (ref !== undefined) {
    const checkedRef = checkRevision(ref);
    if (!checkedRef.ok) return checkedRef;
  }
  const fetched = await runForSuccess(git, [...PROTOCOLS, 'fetch', '--quiet', '--no-tags', '--depth=1', '--', remote, ref ?? 'HEAD'], { cwd: repo });
  return fetched.ok ? resolveRevision(git, repo, 'FETCH_HEAD') : fetched;
}

/** The URL a configured remote fetches from, or undefined when there is no such remote. */
export async function remoteUrl(git: Git, repo: string, name: string): Promise<Result<string | undefined, GitError>> {
  if (!REMOTE_NAME.test(name)) return invalid('remote');
  return configValue(git, repo, `remote.${name}.url`);
}
