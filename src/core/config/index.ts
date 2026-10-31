// Public surface of the config module: the host and its directories, the
// installation config and registering vaults in it, and secret resolution.

export {
  CONFIG_OVERRIDE_VARIABLE,
  STATE_OVERRIDE_VARIABLE,
  currentHost,
  ensurePrivateDir,
  installationPaths,
  pathEntries,
  pathFor,
  platformDirs,
  systemFiles,
  landsWithin,
  realLocation,
  type FileView,
  type Host,
  type InstallationPaths,
  type PlatformDirs,
  type PlatformDirsError,
  type PlatformKind,
} from './platform.ts';
export { claimScratch, newWorkspace, removeScratch, scratchFile, scratchFor, seedDir, sweepScratch, workspaceWrite, SCRATCH_VARIABLE, WORKSPACE_LIMITS } from './scratch.ts';
export {
  parseSecretRef,
  resolveSecret,
  shellCommandRunner,
  systemSecretDeps,
  type CommandOutcome,
  type CommandRunner,
  type SecretDeps,
  type SecretError,
  type SecretRef,
} from './secrets.ts';
export {
  DEFAULT_WILDCARD_MIN,
  FORGE_TYPES,
  MODEL_NAME,
  SOCKET_ACCESS,
  MODEL_ROLES,
  VAULT_ID,
  loadInstallationConfig,
  parseInstallationConfig,
  type ConfigError,
  type ForgeEntry,
  type ForgeType,
  type InstallationConfig,
  type EndpointRole,
  type ModelEndpoint,
  type ModelEntry,
  type ModelRole,
  type SignerConfig,
  type SignerVault,
  type VaultEntry,
  type WebGrantsConfig,
} from './installation.ts';
export { checkPerson, registerVault, type NewVaultEntry, type PersonError, type RegisterError } from './register.ts';
export { describeLauncher, launcherFor, vaultsOnPath, writeLauncher, type Launcher, type LauncherError } from './launcher.ts';
export {
  SERVICE_TOOLS, findPi, findServiceTools, serviceFor, staleServiceTools,
  type ServiceDefinition, type ServiceError, type ServiceProgram, type ServiceTool,
} from './service.ts';
export { packageVersion } from './package.ts';
