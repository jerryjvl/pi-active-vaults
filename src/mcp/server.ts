// One MCP server for one profile (mcp.md): the SDK speaks the protocol; the
// core decides which tools exist and what a call does (`mcpTools`,
// `callMcpTool`). The SDK is given each tool's JSON Schema to show clients,
// but checks nothing against it — the operation's own specs are checked by
// the core, as on every surface, so a call is refused the same way here as
// anywhere else.

import { McpServer, fromJsonSchema, type CallToolResult, type JsonSchemaType, type JsonSchemaValidator, type jsonSchemaValidator } from '@modelcontextprotocol/server';
import { packageVersion } from '../core/config/index.ts';
import { callMcpTool, mcpTools, type McpProfile, type OperationContext } from '../core/operations/index.ts';

export const SERVER_NAME = 'pi-active-vaults';

/** Passes every input on: the core checks parameters against the operation's specs. */
const CHECKED_BY_THE_CORE: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (data) => ({ valid: true, data: data as T, errorMessage: undefined });
  },
};

/** A fresh server for `profile`, as the SDK's serving entries ask for one. */
export function mcpServerFor(context: OperationContext, profile: McpProfile): () => McpServer {
  return () => {
    const server = new McpServer({ name: SERVER_NAME, version: packageVersion() }, { capabilities: { tools: {} } });
    for (const tool of mcpTools(profile)) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType, CHECKED_BY_THE_CORE),
      }, async (args: unknown): Promise<CallToolResult> => {
        const result = await callMcpTool(context, profile, tool.name, args);
        return { content: [{ type: 'text', text: result.text }], structuredContent: { ...result.structured }, isError: result.isError };
      });
    }
    return server;
  };
}
