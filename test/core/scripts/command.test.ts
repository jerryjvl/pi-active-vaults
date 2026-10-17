// Documented behaviour: concepts.md "Script" — a script runs with the
// interpreter in its `#!` line; on Windows through that interpreter, or
// through Git for Windows' `sh` for shell scripts. A script declaring
// `net: no` runs without network access where the platform allows it.
// Every platform's branch is tested here through injected platform values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpreterCommand, restrictNetwork, windowsShellCandidates } from '../../../src/core/scripts/index.ts';

const file = '/tmp/pav-script/.vault/scripts/x';

test('on Linux and macOS the #! line is run as written, with the script and its arguments after it', () => {
  for (const os of ['linux', 'darwin'] as const) {
    assert.deepEqual(interpreterCommand(['/usr/bin/env', 'python3', '-u'], file, ['--date', '2026-01-01'], { os }), {
      ok: true,
      value: { command: '/usr/bin/env', args: ['python3', '-u', file, '--date', '2026-01-01'] },
    });
  }
});

test('on Windows an env lookup or a POSIX path runs the named program from PATH', () => {
  const win = { os: 'win32' as const, windowsShell: 'C:\\Git\\usr\\bin\\sh.exe' };
  assert.deepEqual(interpreterCommand(['/usr/bin/env', 'python3'], 'C:\\t\\x', [], win), { ok: true, value: { command: 'python3', args: ['C:\\t\\x'] } });
  assert.deepEqual(interpreterCommand(['/usr/bin/node', '--no-warnings'], 'C:\\t\\x', ['a'], win), {
    ok: true,
    value: { command: 'node', args: ['--no-warnings', 'C:\\t\\x', 'a'] },
  });
  assert.deepEqual(interpreterCommand(['C:\\Python\\python.exe'], 'C:\\t\\x', [], win), { ok: true, value: { command: 'C:\\Python\\python.exe', args: ['C:\\t\\x'] } });
});

test('on Windows shell scripts run through Git for Windows\' sh, and are refused without it', () => {
  const win = { os: 'win32' as const, windowsShell: 'C:\\Git\\usr\\bin\\sh.exe' };
  for (const line of [['/bin/sh'], ['/bin/bash', '-e'], ['/usr/bin/env', 'bash']]) {
    const command = interpreterCommand(line, 'C:\\t\\x', [], win);
    assert.ok(command.ok, line.join(' '));
    assert.equal(command.value.command, 'C:\\Git\\usr\\bin\\sh.exe');
  }
  assert.equal(interpreterCommand(['/bin/sh'], 'C:\\t\\x', [], { os: 'win32' }).ok, false);
  assert.equal(interpreterCommand(['/usr/bin/env', '-S', 'node --x'], 'C:\\t\\x', [], win).ok, false, 'env options are not interpreted');
});

test('Git for Windows\' sh is looked for relative to git\'s own installation', () => {
  assert.deepEqual(windowsShellCandidates('C:/Program Files/Git/mingw64/libexec/git-core'), [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\sh.exe',
  ]);
});

test('network access is withdrawn with each platform\'s own mechanism, and reported when there is none', () => {
  const command = { command: '/usr/bin/env', args: ['sh', file] };
  assert.deepEqual(restrictNetwork(command, 'unshare'), {
    command: { command: 'unshare', args: ['--user', '--map-current-user', '--net', '--', '/usr/bin/env', 'sh', file] },
    network: 'blocked',
  });
  const sandboxed = restrictNetwork(command, 'sandbox-exec');
  assert.equal(sandboxed.command.command, '/usr/bin/sandbox-exec');
  assert.deepEqual(sandboxed.command.args.slice(-3), ['/usr/bin/env', 'sh', file]);
  assert.match(sandboxed.command.args.join(' '), /deny network/);
  assert.equal(sandboxed.network, 'blocked');
  assert.deepEqual(restrictNetwork(command, 'none'), { command, network: 'unrestricted' });
});
