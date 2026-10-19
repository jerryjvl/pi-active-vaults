// The daemon as a user service (daemon.md "Service installation"), and the
// user's own Pi, which the daemon runs headless sessions with.
//
// One definition per platform: a systemd user unit on Linux, a launchd agent
// on macOS — or, on a Mac nobody logs in to, a launchd daemon run as the
// user — a Task Scheduler task at logon on Windows — with the commands that
// register, start, stop and query it, as programs and arguments. Each runs
// the package's CLI (`vault daemon run`) through the platform's shell, which
// finds `node` on the service's PATH when it starts, so upgrading Node does
// not break it; the daemon finds `pi` the same way when it starts (`findPi`).
//
// That PATH is the one the tools were found on when the service was
// installed: the directory of `node`, `pi` and `git` on the installing PATH,
// as found — links are not followed, so a version manager's `latest` or shim
// directory keeps working across upgrades — ahead of the platform's usual
// directories. A login shell would not do: it rebuilds PATH from profiles
// that a version manager's setup, in an interactive shell's rc file, never
// reaches. `staleServiceTools` says which recorded directory no longer holds
// its tool.
//
// Invariants: the CLI's path and each directory are written so each format
// reads them as one path and nothing more — escaped for systemd (`\`, `"`,
// `%`, `$`), XML-escaped for launchd and Task Scheduler — and one a format
// cannot carry safely (a line break; for `cmd.exe`, a quote or `%`) is
// refused, never written. Windows programs are named by absolute path under
// `%SystemRoot%`.

import { err, ok, type Result } from '../result/index.ts';
import { pathEntries, pathFor, systemFiles, type FileView, type Host } from './platform.ts';

/** A program and its arguments: what the service commands are. */
export interface ServiceProgram {
  readonly file: string;
  readonly args: readonly string[];
}

export interface ServiceDefinition {
  /** Where the definition is written. */
  readonly file: string;
  readonly text: string;
  /** What text encoding the file is written in. */
  readonly encoding: 'utf8' | 'utf16le';
  readonly commands: {
    /** Registers it, after the file is written, to start at login. */
    readonly install: readonly ServiceProgram[];
    readonly start: readonly ServiceProgram[];
    readonly stop: readonly ServiceProgram[];
    /** Exits 0 while it runs. */
    readonly status: readonly ServiceProgram[];
  };
}

/** The tools the service needs on its PATH. */
export const SERVICE_TOOLS = ['node', 'pi', 'git'] as const;

/** A tool and the directory it was found in on PATH, as the PATH named it. */
export interface ServiceTool {
  readonly tool: (typeof SERVICE_TOOLS)[number];
  readonly dir: string;
}

export type ServiceError =
  | { readonly reason: 'unsafe-path'; readonly program: string }
  | { readonly reason: 'not-supported'; readonly os: Host['os'] }
  | { readonly reason: 'no-directory'; readonly variable: string };

const NAME = 'pi-active-vaults';
const LAUNCHD_LABEL = `${NAME}.daemon`;

/** Text as XML element content (no attributes are written from data). */
const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** One systemd argument, double-quoted: backslashes and quotes escaped, `%` specifiers and `$` variables made literal. */
const systemdQuoted = (text: string): string => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`;

/** The directories the service's PATH ends with: where the platform looks when nothing else says. */
const USUAL_PATH: Readonly<Record<'linux' | 'darwin', readonly string[]>> = {
  linux: ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'],
  darwin: ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
};

/** The recorded directories in order, each once. */
const toolDirs = (tools: readonly ServiceTool[]): string[] => [...new Set(tools.map((t) => t.dir))];

/** One systemd assignment, double-quoted: backslashes and quotes escaped, `%` specifiers made literal (`$` is not expanded here). */
const systemdAssignment = (name: string, value: string): string => `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

function linux(host: Host, program: string, dirs: readonly string[]): ServiceDefinition {
  const config = host.env['XDG_CONFIG_HOME'] !== undefined && host.env['XDG_CONFIG_HOME'] !== '' ? host.env['XDG_CONFIG_HOME'] : `${host.home}/.config`;
  const unit = `${NAME}.service`;
  const systemctl = (...args: string[]): ServiceProgram => ({ file: 'systemctl', args: ['--user', ...args] });
  return {
    file: `${config}/systemd/user/${unit}`,
    encoding: 'utf8',
    text: [
      `# ${NAME} daemon, written by "vault daemon install"`,
      '[Unit]',
      'Description=pi-active-vaults daemon: timers, Git events and queued work for vaults',
      '',
      '[Service]',
      'Type=simple',
      systemdAssignment('Environment', `PATH=${[...dirs, ...USUAL_PATH.linux].join(':')}`),
      // Not a login shell: it would rebuild PATH without the directories recorded above.
      `ExecStart=/bin/sh -c 'exec node "$$0" daemon run' ${systemdQuoted(program)}`,
      'Restart=on-failure',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
    commands: {
      install: [systemctl('daemon-reload'), systemctl('enable', unit)],
      start: [systemctl('start', unit)],
      stop: [systemctl('stop', unit)],
      status: [systemctl('is-active', '--quiet', unit)],
    },
  };
}

/**
 * A launchd agent in the user's GUI domain — or, `headless`, a launchd
 * daemon in the system domain, run as the user with their home, for a Mac
 * nobody logs in to (installing it needs administrator rights).
 */
function macos(host: Host, program: string, logs: string, uid: number | undefined, headless: boolean, dirs: readonly string[]): ServiceDefinition {
  const file = headless ? `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist` : `${host.home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
  const domain = headless ? 'system' : `gui/${uid ?? 0}`;
  const launchctl = (...args: string[]): ServiceProgram => ({ file: '/bin/launchctl', args });
  return {
    file,
    encoding: 'utf8',
    text: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`,
      ...(headless ? [`  <key>UserName</key>\n  <string>${xml(host.user)}</string>`] : []),
      '  <key>EnvironmentVariables</key>\n  <dict>',
      ...(headless ? [`    <key>HOME</key>\n    <string>${xml(host.home)}</string>`] : []),
      `    <key>PATH</key>\n    <string>${xml([...dirs, ...USUAL_PATH.darwin].join(':'))}</string>`,
      '  </dict>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...['/bin/sh', '-c', 'exec node "$0" daemon run', program].map((a) => `    <string>${xml(a)}</string>`),
      '  </array>',
      '  <key>RunAtLoad</key>\n  <true/>',
      '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>',
      `  <key>StandardOutPath</key>\n  <string>${xml(`${logs}/daemon.out`)}</string>`,
      `  <key>StandardErrorPath</key>\n  <string>${xml(`${logs}/daemon.err`)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
    commands: {
      install: [launchctl('bootstrap', domain, file)],
      start: [launchctl('kickstart', `${domain}/${LAUNCHD_LABEL}`)],
      stop: [launchctl('kill', 'SIGTERM', `${domain}/${LAUNCHD_LABEL}`)],
      status: [launchctl('print', `${domain}/${LAUNCHD_LABEL}`)],
    },
  };
}

function windows(host: Host, program: string, state: string, dirs: readonly string[]): Result<ServiceDefinition, ServiceError> {
  const root = host.env['SystemRoot'];
  if (root === undefined || root === '') return err({ reason: 'no-directory', variable: 'SystemRoot' });
  const path = pathFor('win32');
  const schtasks = (...args: string[]): ServiceProgram => ({ file: path.join(root, 'System32', 'schtasks.exe'), args });
  const file = path.join(state, `${NAME}-task.xml`);
  const user = xml(host.user);
  return ok({
    file,
    encoding: 'utf16le',
    text: [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo><Description>pi-active-vaults daemon: timers, Git events and queued work for vaults</Description></RegistrationInfo>',
      `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger></Triggers>`,
      `  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
      '  </Settings>',
      '  <Actions Context="Author">',
      '    <Exec>',
      '      <Command>cmd.exe</Command>',
      // cmd.exe finds node on PATH when the task starts: the recorded directories ahead of the user's own, which %PATH% is then.
      `      <Arguments>${xml(`/d /c ${dirs.length === 0 ? '' : `set "PATH=${dirs.join(';')};%PATH%" && `}node "${program}" daemon run`)}</Arguments>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
      '',
    ].join('\r\n'),
    commands: {
      install: [schtasks('/Create', '/TN', NAME, '/XML', file, '/F')],
      start: [schtasks('/Run', '/TN', NAME)],
      stop: [schtasks('/End', '/TN', NAME)],
      status: [schtasks('/Query', '/TN', NAME)],
    },
  });
}

/** The service definition for running `program` (the CLI's entry point) as the daemon on `host`. */
export function serviceFor(
  host: Host, program: string,
  where: { readonly state: string; readonly uid?: number; readonly headless?: boolean; readonly tools?: readonly ServiceTool[] },
): Result<ServiceDefinition, ServiceError> {
  if (/[\r\n\0]/.test(program)) return err({ reason: 'unsafe-path', program });
  const dirs = toolDirs(where.tools ?? []);
  // A line break ends a line in every format; for cmd.exe a quote or % would end its quoting or expand.
  const unsafe = dirs.find((dir) => /[\r\n\0]/.test(dir) || (host.os === 'win32' && /["%;]/.test(dir)));
  if (unsafe !== undefined) return err({ reason: 'unsafe-path', program: unsafe });
  const headless = where.headless === true;
  if (headless && host.os !== 'darwin') return err({ reason: 'not-supported', os: host.os });
  const logs = pathFor(host.os).join(where.state, 'logs');
  switch (host.os) {
    case 'win32':
      return /["%]/.test(program) ? err({ reason: 'unsafe-path', program }) : windows(host, program, where.state, dirs);
    case 'darwin':
      return ok(macos(host, program, logs, where.uid, headless, dirs));
    default:
      return ok(linux(host, program, dirs));
  }
}

/** The `pi` the user runs: found on PATH as the service starts; a JavaScript entry point runs with `node`. */
export function findPi(host: Host, node: string, files: FileView = systemFiles): Result<ServiceProgram, { readonly reason: 'pi-not-found' }> {
  const path = pathFor(host.os);
  for (const dir of pathEntries(host)) {
    if (host.os === 'win32') {
      // npm's pi.cmd only starts node on the package's entry point, which sits beside it.
      if (!files.exists(path.join(dir, 'pi.cmd'))) continue;
      const cli = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
      if (files.exists(cli)) return ok({ file: node, args: [cli] });
      continue;
    }
    const candidate = path.join(dir, 'pi');
    if (!files.exists(candidate)) continue;
    // Resolve the link only to spot a JavaScript entry point: a shim such as
    // mise's or asdf's links to a dispatcher that picks the tool by the name it
    // was run as, so anything else runs by the name found on PATH.
    const real = files.real(candidate);
    return ok(/\.[cm]?js$/.test(real) ? { file: node, args: [real] } : { file: candidate, args: [] });
  }
  return err({ reason: 'pi-not-found' });
}

/** The file names a tool has on a platform. */
function toolFiles(tool: ServiceTool['tool'], os: Host['os']): readonly string[] {
  return os === 'win32' ? [`${tool}.exe`, `${tool}.cmd`, `${tool}.bat`] : [tool];
}


/**
 * Where node, pi and git are on PATH: the first directory that holds each,
 * as PATH names it (so a `latest` link is kept as written). A tool that is
 * on no directory has no entry.
 */
export function findServiceTools(host: Host, files: FileView = systemFiles): ServiceTool[] {
  const path = pathFor(host.os);
  const found: ServiceTool[] = [];
  for (const tool of SERVICE_TOOLS) {
    const dir = pathEntries(host).find((entry) => toolFiles(tool, host.os).some((file) => files.exists(path.join(entry, file))));
    if (dir !== undefined) found.push({ tool, dir });
  }
  return found;
}

/** The recorded tools whose directory no longer holds them: what a service installed earlier can no longer find. */
export function staleServiceTools(recorded: readonly ServiceTool[], host: Host, files: FileView = systemFiles): ServiceTool[] {
  const path = pathFor(host.os);
  return recorded.filter((r) => !toolFiles(r.tool, host.os).some((file) => files.exists(path.join(r.dir, file))));
}
