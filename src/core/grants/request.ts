// Asking the signer for a run's grants, and handing them on (concepts.md
// "Web grants"): the daemon asks before it starts a run whose job has a `web`
// block, and the grants travel in the run file — the script grant to the
// run's scripts as `VAULT_WEB_GRANT`, the item grant to its fan-out items'
// MCP servers as the `X-Vault-Grant` header.
//
// Invariants:
//  - nothing here decides what a grant allows: it only carries what the
//    signer signed, checked for shape and size, so a malformed answer is no
//    grant rather than a guess;
//  - a grant goes only to the MCP servers the installation names for grants,
//    and only to HTTP ones: it never reaches a server that has no use for it.

import { DataReader, err, isRecord, ok, type Issue, type Result } from '../result/index.ts';
import { requestOverSocket, type RequestError } from '../socket/index.ts';
import { WEB_GRANT_KIND } from './kind.ts';
import { GRANT_HEADER, isGrantShaped } from './token.ts';

/** A run's grants, as the run file carries them. */
export interface RunGrants {
  readonly script: string;
  readonly item?: string;
}

export type GrantRequestError =
  | { readonly reason: 'unreachable'; readonly detail: RequestError['reason'] }
  | { readonly reason: 'refused'; readonly refusal: string }
  | { readonly reason: 'malformed' };

/** Grants as read from a run file or a signer's answer: each a grant-shaped token within the size limit. */
export function parseRunGrants(value: unknown, where = 'grants'): Result<RunGrants, Issue[]> {
  const r = new DataReader();
  const g = r.record(value, where, ['script', 'item', 'expires', 'main', 'blob']);
  if (!isGrantShaped(g['script'])) r.add(`${where}.script`, 'is not a grant');
  if (g['item'] !== undefined && !isGrantShaped(g['item'])) r.add(`${where}.item`, 'is not a grant');
  return r.result({ script: g['script'] as string, ...(g['item'] === undefined ? {} : { item: g['item'] as string }) });
}

/** The signer's words for a refusal, as its socket answered: its reason and text, never more. */
function refusalOf(error: unknown): string {
  if (!isRecord(error)) return 'refused';
  return typeof error['text'] === 'string' ? error['text'] : typeof error['reason'] === 'string' ? error['reason'] : 'refused';
}

/** Asks the signer at `socket` for the grants of one run. */
export async function requestGrants(socket: string, request: { readonly vault: string; readonly job: string; readonly trace: string }): Promise<Result<RunGrants, GrantRequestError>> {
  const answer = await requestOverSocket(socket, 'sign', { kind: WEB_GRANT_KIND, ...request });
  if (!answer.ok) {
    return err(answer.error.reason === 'refused' ? { reason: 'refused', refusal: refusalOf(answer.error.error) } : { reason: 'unreachable', detail: answer.error.reason });
  }
  const grants = parseRunGrants(answer.value);
  return grants.ok ? ok(grants.value) : err({ reason: 'malformed' });
}

/** What a running signer says of itself, as far as web grants go. */
export interface SignerStatus {
  readonly version: string;
  readonly kid: string;
  /** Absent when it makes no web grants. */
  readonly wildcardMin?: number;
}

/** Whether the signer at `socket` answers, with what key, and the wildcard minimum it grants under. */
export async function pingSigner(socket: string): Promise<Result<SignerStatus, GrantRequestError>> {
  const answer = await requestOverSocket(socket, 'ping', {});
  if (!answer.ok) {
    return err(answer.error.reason === 'refused' ? { reason: 'refused', refusal: refusalOf(answer.error.error) } : { reason: 'unreachable', detail: answer.error.reason });
  }
  const a = answer.value;
  if (!isRecord(a) || typeof a['version'] !== 'string' || typeof a['kid'] !== 'string' || !isRecord(a['kinds'])) return err({ reason: 'malformed' });
  const web = a['kinds'][WEB_GRANT_KIND];
  const wildcardMin = isRecord(web) && typeof web['wildcardMin'] === 'number' ? web['wildcardMin'] : undefined;
  return ok({ version: a['version'], kid: a['kid'], ...(wildcardMin === undefined ? {} : { wildcardMin }) });
}

/**
 * The MCP server configs, with `grant` in the header of each named in
 * `servers` that is an HTTP server; every other config as it was.
 */
export function withGrantHeader<C extends object>(
  configs: Readonly<Record<string, C>>, servers: readonly string[], grant: string | undefined,
): Record<string, C> {
  if (grant === undefined) return { ...configs };
  return Object.fromEntries(Object.entries(configs).map(([name, config]) => {
    const fields = config as Readonly<Record<string, unknown>>;
    if (!servers.includes(name) || typeof fields['url'] !== 'string') return [name, config];
    const headers = isRecord(fields['headers']) ? fields['headers'] : {};
    return [name, { ...config, headers: { ...headers, [GRANT_HEADER]: grant } }];
  }));
}
