// Public surface of the operations layer: what every surface is generated
// from — the catalogue of operations, reading command lines and calls into
// requests, what each surface shows of an outcome, permission sets and what
// an MCP client sees and may call,
// requesting spawns, and the assembly of the local stores from each module's
// schema.

export { INDEX_MODULES, STATE_MODULES, openIndexStore, openStateStore } from './stores.ts';
export { loadInstallation, type Installation, type InstallationError } from './installation.ts';
export { CATALOGUE, callRequest, callVaultPaths, checkParams, chooseVaults, isRequired, operationNamed, paramsOn, placeVaultPaths, runOperation, type VaultChoiceError } from './catalogue.ts';
export { SCRIPT_TIMEOUT_MS, createContext, packageIdentity, scriptEnvironment, type ContextOptions, type OperationContext } from './context.ts';
export { locate, splitVaultPath, vaultRelative, type Location } from './locate.ts';
export {
  assignPositionals, commandRequest, describeCommandLineError, parseLine, splitArguments, usage, type CommandLineError, type ParsedLine,
} from './commandline.ts';
export { describeError, fromError } from './messages.ts';
export { bearerMatches, callMcpTool, mcpTools, type JsonSchema, type McpTool } from './mcp.ts';
export { MODEL_TEXT_LIMIT, modelResult, outcomeData, type ModelResult, type OutcomeData } from './results.ts';
export { unacceptedNotices, type VaultNotice } from './notices.ts';
export { type Finding } from './ops/doctor.ts';
export { forgeDeps, identityOf, notifyDeps } from './ops/common.ts';
export { queueContext, requestSpawns, spawnLines, spawnMatching, type RequestedSpawns } from './spawning.ts';
export type {
  Caller, Operation, OperationOutcome, OperationRequest, OperationStatus, ParamKind, ParamSpec, ParamSurface, Surfaces, VaultScope,
} from './types.ts';
export {
  PERMISSIONS,
  PERMISSION_GROUPS,
  effectivePermissions,
  mayCall,
  parseMcpConfig,
  permittedOperations,
  type Endpoint,
  type McpConfig,
  type McpProfile,
  type Permission,
} from './permissions.ts';
