// Documented behaviour: cli.md "Conventions" — `vault <command> [vault]
// [args]`, the vault omitted inside one; `--json` on reading commands; exit
// status 0 success, 1 failure, 2 usage error, 3 refused (by policy or a
// guard); commands that need the daemon say so
// and exit 1; every command first reports any vault with an unaccepted change
// on standard error. security.md — adopting shows the delta and asks for
// confirmation first. The commands are generated from the catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, type CliIo } from '../../src/cli/run.ts';
import { CATALOGUE } from '../../src/core/operations/index.ts';
import { createGit } from '../../src/core/git/index.ts';
import { runProcess } from '../../src/core/process/index.ts';
import { withInstallation, type TestInstallation } from '../support/installation.ts';
import { scriptSource } from '../support/vault.ts';

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(t: TestInstallation, options: { cwd?: string; stdin?: string; confirm?: boolean } = {}) {
  return async (...argv: string[]): Promise<Ran> => {
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      write: (stream, text) => {
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      },
      readStdin: async () => options.stdin,
      ...(options.confirm === undefined ? {} : { confirm: async () => options.confirm ?? false }),
      cwd: options.cwd ?? t.repo.path,
      host: t.host,
      context: { git: createGit({ env: t.repo.env }), clock: t.clock, sandbox: 'none', alive: async () => ({ ok: true, value: undefined }) },
    };
    const code = await runCli(argv, io);
    return { code, stdout, stderr };
  };
}

test('help lists every command the catalogue offers on the CLI; a command\'s help is its parameters', withInstallation(async (t) => {
  const vault = cli(t);
  const help = await vault('--help');
  assert.equal(help.code, 0);
  for (const operation of CATALOGUE.filter((o) => o.surfaces.cli)) assert.match(help.stdout, new RegExp(`\\n  ${operation.command ?? operation.name} `));
  const commit = await vault('commit', '--help');
  assert.match(commit.stdout, /^vault commit \[vault\] \[paths\.\.\.\]\n/);
  assert.match(commit.stdout, /-m, --message <message> +The commit message/);
}));

test('a usage error is exit status 2; a command needing the daemon says so and exits 1', withInstallation(async (t) => {
  const vault = cli(t);
  assert.equal((await vault('frobnicate')).code, 2);
  const bad = await vault('read', '--nonsense');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--nonsense is not an option of "read"/);
  assert.equal((await vault('read')).code, 2, 'a required parameter missing');
  for (const argv of [['daemon', 'start'], ['daemon', 'run'], ['mcp', '--profile', 'chat']]) {
    const ran = await vault(...argv);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /needs the daemon/);
  }
}));

test('every command first reports an unaccepted change on standard error', withInstallation(async (t) => {
  t.repo.write('stray.md', 'x');
  const stray = t.repo.commit('stray');
  const ran = await cli(t)('whoami');
  assert.equal(ran.code, 0);
  assert.equal(ran.stdout, 'alice@homeserver\n');
  assert.match(ran.stderr, new RegExp(`Vault "home": main has 1 unaccepted commit\\(s\\), up to ${stray}\\. Automation is paused for this vault\\.`));
}));

test('the vault is the one named first, with --vault, in the path, or the one the current directory is in', withInstallation(async (t) => {
  t.repo.write('notes/a.md', 'A note.\n');
  t.repo.commit('note');
  t.accept();
  const elsewhere = t.dir.file('elsewhere');
  mkdirSync(elsewhere);
  assert.equal((await cli(t, { cwd: join(t.repo.path, 'notes') })('read', 'a.md')).stdout, 'A note.\n', 'relative to the current directory');
  assert.equal((await cli(t, { cwd: elsewhere })('read', 'home', 'notes/a.md')).stdout, 'A note.\n');
  assert.equal((await cli(t, { cwd: elsewhere })('read', '--vault', 'home', 'notes/a.md')).stdout, 'A note.\n');
  assert.equal((await cli(t, { cwd: elsewhere })('read', 'home:notes/a.md')).stdout, 'A note.\n');
  const which = await cli(t, { cwd: elsewhere })('read', 'notes/a.md');
  assert.equal(which.code, 2);
  assert.match(which.stderr, /Which vault\?/);
}));

test('exit statuses: 0 done, 1 failed, 3 refused by policy or a guard; --json gives the data', withInstallation(async (t) => {
  const vault = cli(t);
  assert.equal((await vault('read', 'nowhere.md')).code, 1);
  const refused = await vault('accept', 'gardener');
  assert.equal(refused.code, 3, 'nothing reviewed: refused, not a usage error');
  assert.equal((await vault('trace', 'not-a-trace')).code, 2, 'a malformed request is a usage error');
  const json = await vault('whoami', '--json');
  assert.deepEqual(JSON.parse(json.stdout), { status: 'ok', data: { name: 'alice@homeserver', person: 'alice' }, text: 'alice@homeserver', notices: [] });
  t.repo.write('stray.md', 'x');
  t.repo.commit('stray');
  assert.equal((await vault('reindex')).code, 3, 'the unaccepted-change guard');
}));

test('inside an actor\'s worktree, commits are made as that actor', withInstallation(async (t) => {
  assert.equal((await t.run('write', { path: 'notes/a.md', content: 'A', actor: 'gardener' }, { surface: 'mcp' })).status, 'ok');
  const worktree = join(t.vault.worktrees, 'gardener');
  const committed = await cli(t, { cwd: worktree })('commit', '-m', 'A note');
  assert.equal(committed.code, 0, committed.stderr);
  assert.match(committed.stdout, /^Committed [0-9a-f]{40} on actor\/gardener\./);
  assert.match(t.repo.git('log', '-1', '--format=%B', 'refs/heads/actor/gardener'), /Vault-Actor: gardener/);
}));

test('a notification\'s body comes from standard input', withInstallation(async (t) => {
  const sent = await cli(t, { stdin: 'Hello.\n' })('notify', '--to', 'me', '--subject', 'Hi');
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /^queued <[^>]+@example\.net>\n$/, 'the transport cannot start, so it is kept for retry');
  const { undeliveredNotifications } = await import('../../src/core/notify/index.ts');
  assert.equal(undeliveredNotifications(t.context.state)[0]?.subject, 'Hi');
}, { config: 'notify:\n  from: "Vault <vault@example.net>"\n  recipients: { me: me@example.net }\n  transport: { type: sendmail, command: /nonexistent/sendmail }' }));

test('a script\'s own options pass through to it', { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false }, withInstallation(async (t) => {
  t.repo.write('.vault/scripts/echo.sh', scriptSource('echo', 'echo "$@"'));
  t.repo.commit('script');
  t.accept();
  const ran = await cli(t)('script', 'echo', '--date', '2026-01-01', '-x');
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout, '--date 2026-01-01 -x\n');
}));

test('adopting shows the delta and asks; it is recorded only when confirmed', withInstallation(async (t) => {
  t.repo.write('news.md', 'news');
  const tip = t.repo.commit('news on main');
  const unattended = await cli(t)('accept', '--adopt', tip);
  assert.equal(unattended.code, 3, 'not confirmed: refused');
  assert.match(unattended.stderr, /To adopt it: vault accept home --adopt [0-9a-f]{40} --yes/);
  const declined = await cli(t, { confirm: false })('accept', '--adopt', tip);
  assert.equal(declined.code, 3);
  assert.match(declined.stderr, /Commits:\n {2}[0-9a-f]{12} news on main/);
  assert.match((await cli(t)('whoami')).stderr, /unaccepted/);
  const confirmed = await cli(t, { confirm: true })('accept', '--adopt', tip);
  assert.equal(confirmed.code, 0, confirmed.stderr);
  assert.equal((await cli(t)('whoami')).stderr, '', 'nothing unaccepted any more');
}));

test('vault init creates and registers a vault from the command line', withInstallation(async (t) => {
  const made = await cli(t, { cwd: t.dir.path })('init', 'vaults/notes');
  assert.equal(made.code, 0, made.stderr);
  const listed = await cli(t)('list', '--json');
  assert.deepEqual((JSON.parse(listed.stdout) as { data: { vaults: { id: string }[] } }).data.vaults.map((v) => v.id), ['home', 'notes']);
}));

test('the vault executable runs as a program: arguments in, output and exit status out', withInstallation(async (t) => {
  const ran = await runProcess({
    program: { file: process.execPath, args: [join(import.meta.dirname, '..', '..', 'src', 'cli', 'main.ts'), 'whoami'] },
    env: { ...t.host.env, PATH: process.env['PATH'] ?? '' },
    timeoutMs: 30_000, maxStdoutBytes: 4096, maxStderrBytes: 4096,
  });
  assert.ok(ran.ok);
  assert.equal(ran.value.exitCode, 0, ran.value.stderr.toString());
  assert.equal(ran.value.stdout.toString(), 'alice@homeserver\n');
}));
