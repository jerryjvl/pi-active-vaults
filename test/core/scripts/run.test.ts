// Documented behaviour: concepts.md "Script" and security.md — a script run is
// a propagating action: refused while `main` has an unaccepted change, and
// always running the accepted `main`'s version. Scripts take arguments, print
// results, exit non-zero on failure and never prompt; `net: no` runs without
// network where the platform allows it. Runs use real processes on this
// platform; other platforms' command lines are covered in command.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeNetworkSandbox, runScript, type BuiltinScript, type ScriptRunOptions } from '../../../src/core/scripts/index.ts';
import { startStubServer } from '../../support/stub-server.ts';
import { withTestVault, type TestVault } from '../../support/vault.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };

const script = (name: string, body: string, options: { net?: string; interpreter?: string } = {}): string =>
  `#!${options.interpreter ?? '/bin/sh'}\n# name: ${name}\n# summary: Test script\n# net: ${options.net ?? 'yes'}\n${body}\n`;

function options(v: TestVault, overrides: Partial<ScriptRunOptions> = {}): ScriptRunOptions {
  return {
    kind: 'script',
    builtins: [],
    cwd: v.repo.path,
    env: { PATH: process.env['PATH'] ?? '', GREETING: 'hello' },
    timeoutMs: 10_000,
    os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    sandbox: 'none',
    ...overrides,
  };
}

test('a script runs from the accepted main with its arguments, working directory and only the given environment', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/greet.sh', script('greet', 'echo "$GREETING $1 from $(basename "$PWD")"; echo "${HOME:-no home}"; exit 3'));
  v.repo.commit('script');
  v.accept();
  v.repo.write('.vault/scripts/greet.sh', script('greet', 'echo working tree version'));
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'greet', ['world'], options(v));
  assert.ok(ran.ok);
  assert.deepEqual(ran.value, {
    exitCode: 3,
    stdout: `hello world from ${v.repo.path.split('/').at(-1)}\nno home\n`,
    stderr: '',
    timedOut: false,
    truncated: false,
    network: 'unrestricted',
  });
}));

test('a script run is refused while main has an unaccepted change, and nothing runs', posixOnly, withTestVault(async (v) => {
  const marker = join(v.repo.path, 'ran');
  v.repo.write('.vault/scripts/touch.sh', script('touch', `touch "${marker}"`));
  v.repo.commit('script');
  v.accept();
  v.repo.write('stray.md', 'x');
  v.repo.commit('stray commit on main');
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'touch', [], options(v));
  assert.equal(!ran.ok && ran.error.reason, 'unaccepted-change');
  assert.equal(existsSync(marker), false);
}));

test('a script never prompts: its standard input is closed', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/ask.sh', script('ask', 'if read answer; then echo "got $answer"; else echo "no input"; fi'));
  v.repo.commit('script');
  v.accept();
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'ask', [], options(v));
  assert.equal(ran.ok && ran.value.stdout, 'no input\n');
}));

test('support files from the accepted main sit beside the script', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/lib/words.sh', 'WORD=accepted-support\n');
  v.repo.write('.vault/scripts/use.sh', script('use', '. "$(dirname "$0")/lib/words.sh"; echo "$WORD"'));
  v.repo.commit('script and support');
  v.accept();
  v.repo.write('.vault/scripts/lib/words.sh', 'WORD=working-tree\n');
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'use', [], options(v));
  assert.equal(ran.ok && ran.value.stdout, 'accepted-support\n');
}));

test('a script past its time limit is stopped and reported', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/slow.sh', script('slow', 'sleep 30'));
  v.repo.commit('script');
  v.accept();
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'slow', [], options(v, { timeoutMs: 100 }));
  assert.ok(ran.ok);
  assert.equal(ran.value.timedOut, true);
  assert.equal(ran.value.exitCode, null);
}));

test('output beyond the limit is cut off and reported', posixOnly, withTestVault(async (v) => {
  v.repo.write('.vault/scripts/loud.sh', script('loud', 'i=0; while [ $i -lt 2000 ]; do echo 0123456789; i=$((i+1)); done'));
  v.repo.commit('script');
  v.accept();
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'loud', [], options(v, { maxOutputBytes: 1000 }));
  assert.ok(ran.ok);
  assert.equal(ran.value.truncated, true);
  assert.equal(ran.value.stdout.length, 1000);
}));

test('a built-in runs in the package with the arguments given, never from the vault', withTestVault(async (v) => {
  const calls: (readonly string[])[] = [];
  const echo: BuiltinScript = {
    name: 'echo',
    header: { summary: 'Echo', net: false },
    run: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: args.join(' '), stderr: '' };
    },
  };
  v.accept();
  const ran = await runScript({ git: v.git, store: v.store, vault: v.vault }, 'builtin:echo', ['a', 'b'], options(v, { builtins: [echo] }));
  assert.ok(ran.ok);
  assert.equal(ran.value.stdout, 'a b');
  assert.deepEqual(calls, [['a', 'b']]);
}));

test('net: no withdraws network access where the platform can, and net: yes keeps it', withTestVault(async (v) => {
  const sandbox = await probeNetworkSandbox(options(v).os, options(v).env);
  if (sandbox === 'none') return; // nothing to enforce with on this machine; reported as unrestricted instead
  const server = await startStubServer(() => ({ body: 'ok' }));
  const scratch = mkdtempSync(join(tmpdir(), 'pav-net-'));
  try {
    const fetcher = 'fetch(process.argv[2]).then(() => console.log("reached"), () => console.log("blocked"));';
    v.repo.write('.vault/scripts/offline.js', script('offline', fetcher, { net: 'no', interpreter: process.execPath }).replace(/^# /gm, '// '));
    v.repo.write('.vault/scripts/online.js', script('online', fetcher, { interpreter: process.execPath }).replace(/^# /gm, '// '));
    v.repo.commit('scripts');
    v.accept();
    const run = (name: string) => runScript({ git: v.git, store: v.store, vault: v.vault }, name, [server.url], options(v, { sandbox, cwd: scratch }));
    const offline = await run('offline');
    const online = await run('online');
    assert.ok(offline.ok && online.ok);
    assert.deepEqual([offline.value.stdout, offline.value.network], ['blocked\n', 'blocked']);
    assert.deepEqual([online.value.stdout, online.value.network], ['reached\n', 'unrestricted']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await server.close();
  }
}));
