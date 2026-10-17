// The command line that runs a script, per platform — the one place that
// decides it (principle 19). Everything here is pure, so each platform's
// branch is tested from any platform.
//
// A script runs through the interpreter its `#!` line names, given explicitly,
// so no execute permission or file association is needed. On Windows a POSIX
// interpreter path names a program found on PATH, and shell scripts run
// through Git for Windows' `sh`. A script declaring `net: no` is wrapped in the
// platform's own network isolation where there is one; where there is none the
// run reports that its network was unrestricted.

import { posix, win32 } from 'node:path';
import type { PlatformKind } from '../config/index.ts';
import { err, ok, type Result } from '../result/index.ts';

export interface Command {
  readonly command: string;
  readonly args: readonly string[];
}

/** How this machine can withdraw a process's network access (see `probeNetworkSandbox`). */
export type NetworkSandbox = 'unshare' | 'sandbox-exec' | 'none';

const POSIX_SHELLS = new Set(['sh', 'bash']);

export function interpreterCommand(
  interpreter: readonly string[],
  file: string,
  args: readonly string[],
  platform: { readonly os: PlatformKind; readonly windowsShell?: string },
): Result<Command, string> {
  const [path, ...options] = interpreter;
  if (path === undefined) return err('the script names no interpreter');
  if (platform.os !== 'win32') return ok({ command: path, args: [...options, file, ...args] });

  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return ok({ command: path, args: [...options, file, ...args] });
  let program = posix.basename(path).replace(/\.exe$/i, '');
  let rest = options;
  if (program === 'env') {
    const [named, ...more] = options;
    if (named === undefined || named.startsWith('-')) return err('env options in a #! line are not supported on Windows');
    program = named;
    rest = more;
  }
  if (POSIX_SHELLS.has(program)) {
    if (platform.windowsShell === undefined) return err("shell scripts need Git for Windows' sh, which was not found");
    return ok({ command: platform.windowsShell, args: [...rest, file, ...args] });
  }
  return ok({ command: program, args: [...rest, file, ...args] });
}

/** Where Git for Windows keeps `sh`, given git's `--exec-path` (`<root>/mingw64/libexec/git-core`). */
export function windowsShellCandidates(gitExecPath: string): string[] {
  const root = win32.join(gitExecPath, '..', '..', '..');
  return [win32.join(root, 'usr', 'bin', 'sh.exe'), win32.join(root, 'bin', 'sh.exe')];
}

/** macOS sandbox profile: everything a script may normally do, except use the network. */
const NO_NETWORK_PROFILE = '(version 1)(allow default)(deny network*)';

export function restrictNetwork(command: Command, sandbox: NetworkSandbox): { command: Command; network: 'blocked' | 'unrestricted' } {
  switch (sandbox) {
    case 'unshare':
      // A new network namespace has only a loopback device, and it is down.
      // The user namespace makes this possible unprivileged, mapping the
      // caller's own user so files keep their owner.
      return {
        command: { command: 'unshare', args: ['--user', '--map-current-user', '--net', '--', command.command, ...command.args] },
        network: 'blocked',
      };
    case 'sandbox-exec':
      return {
        command: { command: '/usr/bin/sandbox-exec', args: ['-p', NO_NETWORK_PROFILE, command.command, ...command.args] },
        network: 'blocked',
      };
    case 'none':
      return { command, network: 'unrestricted' };
  }
}

/** The probe that shows a sandbox works here: it must run a harmless command successfully. */
export function sandboxProbe(os: PlatformKind, nodePath: string): { sandbox: NetworkSandbox; command: Command } | undefined {
  const harmless: Command = { command: nodePath, args: ['-e', ''] };
  if (os === 'linux') return { sandbox: 'unshare', command: restrictNetwork(harmless, 'unshare').command };
  if (os === 'darwin') return { sandbox: 'sandbox-exec', command: restrictNetwork(harmless, 'sandbox-exec').command };
  return undefined;
}
