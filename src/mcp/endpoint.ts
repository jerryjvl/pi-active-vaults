// A profile's endpoint (mcp.md "Rules"): HTTP at `/mcp`, on a loopback
// address and port or a socket path, served through the core's socket
// module. Stateless: each request is served by a fresh server for the
// profile, so no client state lives between requests.
//
// Invariants:
//  - a request on an address and port carries the profile's bearer token, or
//    is answered 401 before anything else reads it; a socket endpoint is
//    protected by being the user's alone, and checks a token too if the
//    profile has one. An address and port without a token is never served;
//  - the token is resolved once, at start; an endpoint whose token cannot be
//    resolved does not start, and the error names where it is configured,
//    never its value;
//  - request bodies are bounded.

import { createMcpHandler } from '@modelcontextprotocol/server';
import { resolveSecret } from '../core/config/index.ts';
import { bearerMatches, type Endpoint, type McpProfile, type OperationContext } from '../core/operations/index.ts';
import { err, ok, type Result } from '../core/result/index.ts';
import { listenHttp, type ListenError } from '../core/socket/index.ts';
import { mcpServerFor } from './server.ts';

/** The path an endpoint serves MCP at. */
export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpEndpoint {
  readonly profile: string;
  /** The URL clients use, or the socket path. */
  readonly address: string;
  close(): Promise<void>;
}

export type McpEndpointError =
  | { readonly reason: 'no-endpoint' }
  | { readonly reason: 'no-token' }
  | { readonly reason: 'token'; readonly where: string }
  | ListenError;

const unauthorised = (): Response => new Response('A bearer token is required.\n', { status: 401, headers: { 'www-authenticate': 'Bearer' } });

/** Serves `profile` at its endpoint (or `options.endpoint`) until closed. */
export async function startMcpEndpoint(
  context: OperationContext, profile: McpProfile, options: { readonly endpoint?: Endpoint } = {},
): Promise<Result<McpEndpoint, McpEndpointError>> {
  const endpoint = options.endpoint ?? profile.listen;
  if (endpoint === undefined) return err({ reason: 'no-endpoint' });
  if (endpoint.kind === 'tcp' && profile.token === undefined) return err({ reason: 'no-token' });
  let token: string | undefined;
  if (profile.token !== undefined) {
    const resolved = await resolveSecret(profile.token, context.secrets);
    if (!resolved.ok) return err({ reason: 'token', where: resolved.error.where });
    token = resolved.value;
  }
  const mcp = createMcpHandler(mcpServerFor(context, profile), { maxRequestBodySize: MAX_BODY_BYTES });
  const { fetch: serve } = mcp;
  const served = await listenHttp(endpoint, async (request) => {
    if (new URL(request.url).pathname !== MCP_PATH) return new Response('Not found.\n', { status: 404 });
    if (token !== undefined && !bearerMatches(request.headers.get('authorization') ?? undefined, token)) return unauthorised();
    return serve(request);
  }, { maxBodyBytes: MAX_BODY_BYTES });
  if (!served.ok) {
    await mcp.close();
    return served;
  }
  return ok({
    profile: profile.name,
    address: endpoint.kind === 'tcp' ? `${served.value.url}${MCP_PATH}` : served.value.url,
    async close() {
      await mcp.close();
      await served.value.close();
    },
  });
}
