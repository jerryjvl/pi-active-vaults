// An endpoint (mcp.md "Rules", "Sharing an endpoint"): HTTP at `/mcp`, on a
// loopback address and port or a socket path, served through the core's socket
// module, for one profile or several chosen by path (`profileForPath`).
// Stateless: each request is served by a fresh server for its profile, so no
// client state lives between requests.
//
// Invariants:
//  - a request on an address and port carries the bearer token of the profile
//    its path chooses, or is answered 401 before anything else reads it; a
//    socket endpoint is protected by being the user's alone, and checks a token
//    too if the profile has one. A profile on an address and port without a
//    token is never served;
//  - every profile's token is resolved once, at start; an endpoint with a
//    token that cannot be resolved does not start, and the error names where
//    it is configured, never its value;
//  - request bodies are bounded.

import { createMcpHandler } from '@modelcontextprotocol/server';
import { resolveSecret } from '../core/config/index.ts';
import { MCP_PATH, bearerMatches, profileForPath, type Endpoint, type McpProfile, type OperationContext } from '../core/operations/index.ts';
import { err, ok, type Result } from '../core/result/index.ts';
import { listenHttp, type ListenError } from '../core/socket/index.ts';
import { mcpServerFor } from './server.ts';

export { MCP_PATH };
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A profile being served, and where its clients reach it. */
export interface McpServed {
  readonly profile: string;
  /** The URL clients use, or the socket path. */
  readonly address: string;
}

export interface McpEndpoint {
  /** Each profile on the endpoint, in the order given. */
  readonly served: readonly McpServed[];
  close(): Promise<void>;
}

export type McpEndpointError =
  | { readonly reason: 'no-endpoint' }
  | { readonly reason: 'no-token' }
  | { readonly reason: 'token'; readonly where: string }
  | ListenError;

const unauthorised = (): Response => new Response('A bearer token is required.\n', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
const notFound = (): Response => new Response('Not found.\n', { status: 404 });

/** Serves `profiles` together at the first one's endpoint (or `options.endpoint`) until closed. */
export async function startMcpEndpoint(
  context: OperationContext, profiles: readonly McpProfile[], options: { readonly endpoint?: Endpoint } = {},
): Promise<Result<McpEndpoint, McpEndpointError>> {
  const endpoint = options.endpoint ?? profiles[0]?.listen;
  if (endpoint === undefined) return err({ reason: 'no-endpoint' });
  if (endpoint.kind === 'tcp' && profiles.some((p) => p.token === undefined)) return err({ reason: 'no-token' });
  const tokens = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.token === undefined) continue;
    const resolved = await resolveSecret(profile.token, context.secrets);
    if (!resolved.ok) return err({ reason: 'token', where: resolved.error.where });
    tokens.set(profile.name, resolved.value);
  }
  const routes = new Map(profiles.map((p) => {
    const { fetch: serve, close } = createMcpHandler(mcpServerFor(context, p), { maxRequestBodySize: MAX_BODY_BYTES });
    return [p.name, { token: tokens.get(p.name), serve, close }];
  }));
  const closeHandlers = async (): Promise<void> => {
    for (const route of routes.values()) await route.close();
  };
  const served = await listenHttp(endpoint, async (request) => {
    const profile = profileForPath(profiles, new URL(request.url).pathname);
    const route = profile === undefined ? undefined : routes.get(profile.name);
    if (route === undefined) return notFound();
    if (route.token !== undefined && !bearerMatches(request.headers.get('authorization') ?? undefined, route.token)) return unauthorised();
    return route.serve(request);
  }, { maxBodyBytes: MAX_BODY_BYTES });
  if (!served.ok) {
    await closeHandlers();
    return served;
  }
  // A profile alone keeps the plain `/mcp` its clients have always used; on a shared endpoint each is named.
  const address = (name: string): string => endpoint.kind !== 'tcp'
    ? served.value.url
    : `${served.value.url}${MCP_PATH}${profiles.length === 1 ? '' : `/${name}`}`;
  return ok({
    served: profiles.map((p) => ({ profile: p.name, address: address(p.name) })),
    async close() {
      await closeHandlers();
      await served.value.close();
    },
  });
}
