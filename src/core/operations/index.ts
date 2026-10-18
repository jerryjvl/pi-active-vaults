// Public surface of the operations layer: what every surface is generated
// from — the catalogue of operations, permission sets, and the assembly of
// the local stores from each module's schema.

export { INDEX_MODULES, STATE_MODULES, openIndexStore, openStateStore } from './stores.ts';
export { loadInstallation, type Installation, type InstallationError } from './installation.ts';
export { CATALOGUE, checkParams, chooseVaults, operationNamed, paramsOn, placeVaultPaths, runOperation, type VaultChoiceError } from './catalogue.ts';
export { SCRIPT_TIMEOUT_MS, createContext, packageIdentity, scriptEnvironment, type ContextOptions, type OperationContext } from './context.ts';
export { locate, splitVaultPath, vaultRelative, type Location } from './locate.ts';
export { assignPositionals, parseLine, splitArguments, usage, type ParsedLine } from './commandline.ts';
export { describeError, fromError } from './messages.ts';
export { unacceptedNotices, type VaultNotice } from './notices.ts';
export { doctorFindings, type Finding } from './ops/doctor.ts';
export { queueContext, spawnLines, spawnMatching } from './ops/common.ts';
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
