// The installation as every surface loads it: the machine's directories, the
// config file, and the sections other modules own — `notify` and `mcp` —
// validated in the same pass, so a mistake anywhere in the file is reported
// when it loads, with every other problem, and no surface runs on a partly
// valid config.
//
// A machine with no config file is an installation with no vaults: the
// package degrades to doing nothing rather than failing (principle 15), and
// `vault init` or `vault add` creates the file.

import {
  installationPaths,
  loadInstallationConfig,
  parseInstallationConfig,
  platformDirs,
  type ConfigError,
  type Host,
  type InstallationConfig,
  type InstallationPaths,
  type PlatformDirsError,
} from '../config/index.ts';
import { parseNotifyConfig, type NotifyConfig } from '../notify/index.ts';
import { registeredVaults, type RegisteredVault } from '../registry/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import { parseMcpConfig, type McpConfig } from './permissions.ts';

export interface Installation {
  readonly host: Host;
  readonly paths: InstallationPaths;
  readonly config: InstallationConfig;
  /** Whether the config file exists; without one the installation has no vaults. */
  readonly configFound: boolean;
  readonly vaults: readonly RegisteredVault[];
  /** Absent when notifications are not configured. */
  readonly notify?: NotifyConfig;
  readonly mcp: McpConfig;
}

export type InstallationError = PlatformDirsError | ConfigError;

export function loadInstallation(host: Host): Result<Installation, InstallationError> {
  const dirs = platformDirs(host);
  if (!dirs.ok) return dirs;
  const paths = installationPaths(dirs.value, host.os);
  let configFound = true;
  let loaded = loadInstallationConfig(paths.configFile, host);
  if (!loaded.ok && loaded.error.reason === 'not-found') {
    configFound = false;
    loaded = parseInstallationConfig('', host);
  }
  if (!loaded.ok) return loaded;
  const config = loaded.value;

  const issues: Issue[] = [];
  const notify = parseNotifyConfig(config.notify);
  if (!notify.ok) issues.push(...notify.error);
  const mcp = parseMcpConfig(config.mcp, config.vaults.map((v) => v.id));
  if (!mcp.ok) issues.push(...mcp.error);
  if (!notify.ok || !mcp.ok) return err({ reason: 'invalid', issues });

  return ok({
    host,
    paths,
    config,
    configFound,
    vaults: registeredVaults(config, paths, host.os),
    ...(notify.value === undefined ? {} : { notify: notify.value }),
    mcp: mcp.value,
  });
}
