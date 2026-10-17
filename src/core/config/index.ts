// Public surface of the config module: the host and its directories, the
// installation config, and secret resolution.

export type { ConfigIssue } from './issue.ts';
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
