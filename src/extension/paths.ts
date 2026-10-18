// The files a Pi tool call reads and writes, as Pi's own tools read their path
// arguments — so the guard and taint judge the file the tool will touch.
//
// Mirrors Pi 1.3's `resolveToCwd` (dist/utils/paths.js), which Pi does not
// export: a leading `@` dropped, Unicode spaces read as spaces, on Windows a
// shell path such as `/c/x` or `/mnt/c/x` read as `C:\x`, `~` as the home
// directory, a `file://` URL as its path, and anything relative from the
// session's directory. Only Pi's built-in tools are known here; other tools'
// arguments are their own business.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function windowsShellPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return path;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
  return match === null ? path : `${(match[1] ?? '').toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
}

/** Where a path argument of Pi's tools points, from `cwd`. */
export function piPath(input: string, cwd: string): string {
  let path = input.replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (process.platform === 'win32') path = windowsShellPath(path);
  if (path === '~') path = homedir();
  else if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) path = join(homedir(), path.slice(2));
  else if (/^file:\/\//.test(path)) path = fileURLToPath(path);
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

const text = (input: Readonly<Record<string, unknown>>, key: string): string | undefined => (typeof input[key] === 'string' ? input[key] : undefined);

/** The files a built-in tool writes. */
export function writesOf(tool: string, input: Readonly<Record<string, unknown>>, cwd: string): string[] {
  const path = text(input, 'path');
  return (tool === 'write' || tool === 'edit') && path !== undefined ? [piPath(path, cwd)] : [];
}

/** The files and directories a built-in tool reads (search tools default to the session's directory). */
export function readsOf(tool: string, input: Readonly<Record<string, unknown>>, cwd: string): string[] {
  const path = text(input, 'path');
  if (tool === 'read' || tool === 'edit') return path === undefined ? [] : [piPath(path, cwd)];
  if (tool === 'grep' || tool === 'find' || tool === 'ls') return [piPath(path ?? '.', cwd)];
  return [];
}

/** The shell command a built-in shell tool runs. */
export function shellOf(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
  return tool === 'bash' || tool === 'powershell' ? text(input, 'command') : undefined;
}
