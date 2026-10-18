// The daemon as a user service (daemon.md "Service installation"), and the
// user's own Pi, which the daemon runs headless sessions with.
//
// One definition per platform: a systemd user unit on Linux, a launchd agent
// on macOS — or, on a Mac nobody logs in to, a launchd daemon run as the
// user — a Task Scheduler task at logon on Windows — with the commands that
// register, start, stop and query it, as programs and arguments. Each runs
// the package's CLI (`vault daemon run`) through the platform's shell, which
// finds `node` on PATH when the service starts, so upgrading Node does not
// break it; the daemon finds `pi` the same way when it starts (`findPi`).
//
// Invariants: the CLI's path is written so each format reads it as one path
// and nothing more — escaped for systemd (`\`, `"`, `%`, `$`), XML-escaped
// for launchd and Task Scheduler — and a path a format cannot carry safely (a
// line break; for `cmd.exe`, a quote or `%`) is refused, never written.
// Windows programs are named by absolute path under `%SystemRoot%`.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { err, ok, type Result } from '../result/index.ts';
import { pathFor, type Host } from './platform.ts';

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

function linux(host: Host, program: string): ServiceDefinition {
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
      // A login shell finds node on the user's PATH as it is when the service starts.
      `ExecStart=/bin/sh -lc 'exec node "$$0" daemon run' ${systemdQuoted(program)}`,
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
function macos(host: Host, program: string, logs: string, uid: number | undefined, headless: boolean): ServiceDefinition {
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
      ...(headless ? [
        `  <key>UserName</key>\n  <string>${xml(host.user)}</string>`,
        `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>${xml(host.home)}</string>\n  </dict>`,
      ] : []),
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...['/bin/sh', '-lc', 'exec node "$0" daemon run', program].map((a) => `    <string>${xml(a)}</string>`),
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

function windows(host: Host, program: string, state: string): Result<ServiceDefinition, ServiceError> {
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
      // cmd.exe finds node on PATH when the task starts.
      `      <Arguments>${xml(`/d /c node "${program}" daemon run`)}</Arguments>`,
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
  host: Host, program: string, where: { readonly state: string; readonly uid?: number; readonly headless?: boolean },
): Result<ServiceDefinition, ServiceError> {
  if (/[\r\n\0]/.test(program)) return err({ reason: 'unsafe-path', program });
  const headless = where.headless === true;
  if (headless && host.os !== 'darwin') return err({ reason: 'not-supported', os: host.os });
  const logs = pathFor(host.os).join(where.state, 'logs');
  switch (host.os) {
    case 'win32':
      return /["%]/.test(program) ? err({ reason: 'unsafe-path', program }) : windows(host, program, where.state);
    case 'darwin':
      return ok(macos(host, program, logs, where.uid, headless));
    default:
      return ok(linux(host, program));
  }
}

/** How files are looked at: the file system, or a stand-in in tests of another platform's branch. */
export interface FileView {
  exists(path: string): boolean;
  /** Where a path really is, through links. */
  real(path: string): string;
}

const systemFiles: FileView = {
  exists: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  real: (path) => (existsSync(path) ? realpathSync(path) : path),
};

/** The `pi` the user runs: found on PATH as the service starts; a JavaScript entry point runs with `node`. */
export function findPi(host: Host, node: string, files: FileView = systemFiles): Result<ServiceProgram, { readonly reason: 'pi-not-found' }> {
  const path = pathFor(host.os);
  const entries = (host.env['PATH'] ?? host.env['Path'] ?? '').split(host.os === 'win32' ? ';' : ':').filter((e) => e !== '');
  for (const dir of entries) {
    if (host.os === 'win32') {
      // npm's pi.cmd only starts node on the package's entry point, which sits beside it.
      if (!files.exists(path.join(dir, 'pi.cmd'))) continue;
      const cli = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
      if (files.exists(cli)) return ok({ file: node, args: [cli] });
      continue;
    }
    const candidate = path.join(dir, 'pi');
    if (!files.exists(candidate)) continue;
    const real = files.real(candidate);
    return ok(/\.[cm]?js$/.test(real) ? { file: node, args: [real] } : { file: real, args: [] });
  }
  return err({ reason: 'pi-not-found' });
}
