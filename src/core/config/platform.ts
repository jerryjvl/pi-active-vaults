// The machine: which platform, where its per-user directories are, and the
// files the package keeps there. The environment is read once into a `Host` and
// passed in, so every platform's branch can be tested from any platform.
//
// Path flavour follows the host's platform, not the platform running the code.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, hostname, platform, userInfo } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { err, ok, type Result } from '../result/index.ts';

export type PlatformKind = 'linux' | 'darwin' | 'win32';

export interface Host {
  readonly os: PlatformKind;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly user: string;
  readonly hostname: string;
}

export interface PlatformDirs {
  readonly config: string;
  readonly state: string;
}

export interface InstallationPaths {
  readonly configFile: string;
  readonly stateDb: string;
  readonly indexDb: string;
  readonly logs: string;
  /** Where actor worktrees go for vaults that do not configure their own: `<worktrees>/<vault-id>`. */
  readonly worktrees: string;
  /** The daemon's socket: a Unix domain socket in the state directory, a named pipe on Windows. */
  readonly socket: string;
  /** The run files the daemon writes for its headless sessions. */
  readonly runs: string;
  /** Where vaults' Git hooks leave word that refs changed, one file per vault. */
  readonly refs: string;
  /** The editor workspace `vault workspace` writes: the person's worktree in each vault. */
  readonly workspace: string;
  /** Sessions' scratch directories, one per trace (scratch.ts). */
  readonly scratch: string;
  /** The signer's default socket, when its config names none: in the state directory, a named pipe on Windows. */
  readonly signerSocket: string;
  /** The signer's own store: the grants it has issued (grants module). */
  readonly signerDb: string;
  /** The signer's own fetches of the vaults it signs for, one repository each. */
  readonly signerRepos: string;
}

export type PlatformDirsError = { reason: 'relative-override'; variable: string };

/** The package's own directory name under each platform's per-user location. */
const APP_DIR = 'pi-active-vaults';
export const CONFIG_OVERRIDE_VARIABLE = 'PI_ACTIVE_VAULTS_CONFIG';
export const STATE_OVERRIDE_VARIABLE = 'PI_ACTIVE_VAULTS_STATE';

export function pathFor(os: PlatformKind): typeof posix {
  return os === 'win32' ? win32 : posix;
}

export function currentHost(): Host {
  const os = platform();
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers): fall back to the environment.
    user = process.env['USER'] ?? process.env['USERNAME'] ?? 'user';
  }
  return {
    // Other POSIX systems follow the XDG layout.
    os: os === 'darwin' || os === 'win32' ? os : 'linux',
    env: process.env,
    home: homedir(),
    user,
    hostname: hostname(),
  };
}

function absoluteEnv(host: Host, name: string): string | undefined {
  const value = host.env[name];
  return value !== undefined && pathFor(host.os).isAbsolute(value) ? value : undefined;
}

function defaultBases(host: Host): { config: string; state: string } {
  const p = pathFor(host.os);
  switch (host.os) {
    case 'darwin': {
      const base = p.join(host.home, 'Library', 'Application Support');
      return { config: base, state: base };
    }
    case 'win32':
      return {
        config: absoluteEnv(host, 'APPDATA') ?? p.join(host.home, 'AppData', 'Roaming'),
        state: absoluteEnv(host, 'LOCALAPPDATA') ?? p.join(host.home, 'AppData', 'Local'),
      };
    case 'linux':
      // The XDG specification says a relative value must be ignored.
      return {
        config: absoluteEnv(host, 'XDG_CONFIG_HOME') ?? p.join(host.home, '.config'),
        state: absoluteEnv(host, 'XDG_STATE_HOME') ?? p.join(host.home, '.local', 'state'),
      };
  }
}

/**
 * The directories for config and state. An override replaces the whole
 * directory; a relative one is refused because there is no sensible base to
 * resolve it against.
 */
export function platformDirs(host: Host): Result<PlatformDirs, PlatformDirsError> {
  const p = pathFor(host.os);
  const bases = defaultBases(host);
  const resolved: Record<'config' | 'state', string> = {
    config: p.join(bases.config, APP_DIR),
    state: p.join(bases.state, APP_DIR),
  };
  for (const [which, variable] of [
    ['config', CONFIG_OVERRIDE_VARIABLE],
    ['state', STATE_OVERRIDE_VARIABLE],
  ] as const) {
    const override = host.env[variable];
    if (override === undefined || override === '') continue;
    if (!p.isAbsolute(override)) return err({ reason: 'relative-override', variable });
    resolved[which] = override;
  }
  return ok(resolved);
}

export function installationPaths(dirs: PlatformDirs, os: PlatformKind): InstallationPaths {
  const p = pathFor(os);
  return {
    configFile: p.join(dirs.config, 'config.yaml'),
    stateDb: p.join(dirs.state, 'state.sqlite'),
    indexDb: p.join(dirs.state, 'index.sqlite'),
    logs: p.join(dirs.state, 'logs'),
    worktrees: p.join(dirs.state, 'worktrees'),
    socket: os === 'win32' ? windowsPipe(dirs.state) : p.join(dirs.state, 'daemon.sock'),
    signerSocket: os === 'win32' ? windowsPipe(dirs.state, 'signer') : p.join(dirs.state, 'signer.sock'),
    signerDb: p.join(dirs.state, 'signer.sqlite'),
    signerRepos: p.join(dirs.state, 'signer'),
    runs: p.join(dirs.state, 'runs'),
    refs: p.join(dirs.state, 'refs'),
    workspace: p.join(dirs.state, 'vaults.code-workspace'),
    scratch: p.join(dirs.state, 'scratch'),
  };
}

/** Named pipes share one namespace per machine, so the pipe is named after the state directory it belongs to. */
function windowsPipe(state: string, role?: string): string {
  return `\\\\.\\pipe\\${APP_DIR}-${role === undefined ? '' : `${role}-`}${createHash('sha256').update(state.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/**
 * Create a directory (and any missing parents) accessible only to the user.
 * Existing directories are left as they are: an override may point at a place
 * the user shares on purpose, and `vault doctor` is where permissions get
 * reported. The mode has no effect on Windows, where the profile directories'
 * default ACLs already restrict access to the user.
 */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Where `path` really is: resolved as written, then through the links of the
 * deepest directory on the way that exists, with the rest kept as written —
 * so a file not made yet is placed where writing it would put it. What a
 * guard compares, since a link on the way can lead anywhere.
 */
export function realLocation(path: string): string {
  const full = resolve(path);
  let existing = full;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try {
    return join(realpathSync.native(existing), relative(existing, full));
  } catch {
    return full;
  }
}

/** Where `inner` really lands inside `outer`, as a relative path with `/` (`''` for `outer` itself), or undefined when it lands outside. */
export function landsWithin(outer: string, inner: string): string | undefined {
  const rel = relative(realLocation(outer), realLocation(inner));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** How files are looked at: the file system, or a stand-in in tests of another platform's branch. */
export interface FileView {
  exists(path: string): boolean;
  /** Where a path really is, through links. */
  real(path: string): string;
}

export const systemFiles: FileView = {
  exists: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  real: (path) => (existsSync(path) ? realpathSync(path) : path),
};

/** The directories of the host's PATH, in order, as written. */
export function pathEntries(host: Host): string[] {
  return (host.env['PATH'] ?? host.env['Path'] ?? '').split(host.os === 'win32' ? ';' : ':').filter((e) => e !== '');
}
