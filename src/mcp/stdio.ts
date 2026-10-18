// A profile over standard input/output (`vault mcp --profile`, mcp.md): JSON
// lines between this process and the client that started it, which it
// trusts as it trusts any process of the user's. It ends when its input does.

import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import type { McpProfile, OperationContext } from '../core/operations/index.ts';
import { mcpServerFor } from './server.ts';

export interface McpStdio {
  /** Resolves once the client closed its end. */
  readonly ended: Promise<void>;
  close(): Promise<void>;
}

export function serveMcpStdio(context: OperationContext, profile: McpProfile, streams: { readonly input: Readable; readonly output: Writable }): McpStdio {
  const ended = new Promise<void>((resolve) => {
    streams.input.once('end', () => resolve());
    streams.input.once('close', () => resolve());
  });
  const handle = serveStdio(mcpServerFor(context, profile), { transport: new StdioServerTransport(streams.input, streams.output) });
  return { ended, close: () => handle.close() };
}
