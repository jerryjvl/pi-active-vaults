// The MCP adapter (mcp.md): profiles served on their endpoints by the daemon,
// or over standard input/output by `vault mcp`. What a client sees and may
// do is the core's (operations `mcp`); this adapter carries the protocol.

export { MCP_PATH, startMcpEndpoint, type McpEndpoint, type McpEndpointError } from './endpoint.ts';
export { SERVER_NAME, mcpServerFor } from './server.ts';
export { serveMcpStdio, type McpStdio } from './stdio.ts';
