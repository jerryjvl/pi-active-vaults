// Public surface of the config module: the host and its directories, the
// installation config and registering vaults in it, and secret resolution.

export {
  CONFIG_OVERRIDE_VARIABLE,
  STATE_OVERRIDE_VARIABLE,
  currentHost,
  ensurePrivateDir,
  installationPaths,
  pathFor,
  platformDirs,
  type Host,
  type InstallationPaths,
  type PlatformDirs,
  type PlatformDirsError,
  type PlatformKind,
} from './platform.ts';
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
  FORGE_TYPES,
  MODEL_ROLES,
  VAULT_ID,
  loadInstallationConfig,
  parseInstallationConfig,
  type ConfigError,
  type ForgeEntry,
  type ForgeType,
  type InstallationConfig,
  type ModelEndpoint,
  type ModelRole,
  type VaultEntry,
} from './installation.ts';
export { registerVault, type NewVaultEntry, type RegisterError } from './register.ts';
