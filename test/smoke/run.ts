// The opt-in real-Pi smoke test (`npm run smoke`; not part of `npm test`):
// one headless job through the daemon's own execution path — `vault trigger`
// from the CLI, the daemon claiming and scheduling it, `pi --mode rpc` with
// the Pi dev dependency loading the built extension — against a real model
// endpoint; then a second job, triggered by the first run's commit, that
// requires its originating session, so the daemon must start it as a fork of
// the first run's real Pi session file. Everything lives in temporary
// directories: a vault, the installation's config and state, and Pi's agent
// and session directories; nothing of the user's is read or touched.
//
// Environment:
//   PAV_SMOKE_BASE_URL   the endpoint, e.g. http://localhost:4000/v1 (required)
//   PAV_SMOKE_MODEL      the model ID the endpoint serves (required)
//   PAV_SMOKE_API        Pi's API type for it (default openai-completions)
//   PAV_SMOKE_API_KEY    its key, if it needs one
//   PAV_SMOKE_TIMEOUT    how long to wait for both runs, in seconds (default 600)
//   PAV_SMOKE_KEEP=1     keep the temporary directories, to look at afterwards
//
// It reports each run's outcome, commit, trailers, trace record and whether
// the second was forked, and exits 0 only when both committed and the second
// was forked; 2 when it is not configured.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli/run.ts';
import type { Notice } from '../../src/core/automation/index.ts';
import type { Host } from '../../src/core/config/index.ts';
import { readFullLog, TRACES_REF } from '../../src/core/traces/index.ts';
import { startDaemon } from '../../src/daemon/daemon.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PI_CLI = join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
const EXTENSION = join(ROOT, 'dist', 'extension', 'index.js');

const env = process.env;
const baseUrl = env['PAV_SMOKE_BASE_URL'];
const model = env['PAV_SMOKE_MODEL'];
if (baseUrl === undefined || baseUrl === '' || model === undefined || model === '') {
  process.stderr.write('npm run smoke: set PAV_SMOKE_BASE_URL and PAV_SMOKE_MODEL (see test/smoke/run.ts).\n');
  process.exit(2);
}
if (!existsSync(EXTENSION) || !existsSync(PI_CLI)) {
  process.stderr.write(`npm run smoke: ${existsSync(PI_CLI) ? 'build first (npm run build)' : 'install the dev dependencies (npm install)'}.\n`);
  process.exit(2);
}
const timeoutMs = Number(env['PAV_SMOKE_TIMEOUT'] ?? '600') * 1000;

const box = mkdtempSync(join(tmpdir(), 'pav-smoke-'));
const dirs = { vault: join(box, 'vault'), config: join(box, 'config'), state: join(box, 'state'), agent: join(box, 'agent'), sessions: join(box, 'sessions'), home: join(box, 'home') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.net', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

const job = (conditions: string, body: string): string =>
  `---\napplies-when: ${conditions}\nbudget: { tokens: 200000, ttl: 10m }\nactor: gardener\n---\n${body}\n`;

// The vault: a root contract and two jobs.
git(dirs.vault, 'init', '--quiet', '--initial-branch', 'main');
writeFileSync(join(dirs.vault, '_contract.md'), [
  '---', 'vault:', '  id: smoke', '  purpose: { summary: A smoke test. }', '  audience: the smoke test', '  owners: [alice]', '  actors: [gardener]', '---', 'A vault for one smoke test.', '',
].join('\n'));
mkdirSync(join(dirs.vault, 'jobs'));
writeFileSync(join(dirs.vault, 'jobs', 'first.md'), job('[{ on: external, name: smoke, effect: spawn }]',
  'Write a document notes/smoke.md in your worktree whose body is the single word "pong". Then commit it with the vault_commit tool, with the message "Smoke". Do nothing else.'));
writeFileSync(join(dirs.vault, 'jobs', 'second.md'), job('[{ on: committed, paths: ["notes/smoke.md"], actor: [gardener], effect: spawn, context: session-required }]',
  'Add a line "forked" at the end of notes/smoke.md in your worktree, then commit it with the vault_commit tool, with the message "Forked". Do nothing else.'));
git(dirs.vault, 'add', '--all');
git(dirs.vault, 'commit', '--quiet', '--message', 'Create the smoke vault');

// The installation, and Pi's own directories: the endpoint as Pi's only model, the package as its only extension.
writeFileSync(join(dirs.config, 'config.yaml'), [
  'installation: { name: alice@smoke, person: alice }',
  `vaults: [{ id: smoke, path: ${JSON.stringify(dirs.vault)}, host: true }]`,
  'budgets: { daily-tokens: 2000000, cascade-pool: 400000 }',
  'taint: { trusted-tools: [read, write, edit, vault_commit, vault_read] }',
  '',
].join('\n'), { mode: 0o600 });
writeFileSync(join(dirs.agent, 'models.json'), JSON.stringify({
  providers: { smoke: { baseUrl, api: env['PAV_SMOKE_API'] ?? 'openai-completions', apiKey: env['PAV_SMOKE_API_KEY'] === undefined ? 'none' : '$PAV_SMOKE_API_KEY', models: [{ id: model }] } },
}, null, 2));
writeFileSync(join(dirs.agent, 'settings.json'), JSON.stringify({ defaultProvider: 'smoke', defaultModel: model, packages: [ROOT] }, null, 2));

const machineEnv: Record<string, string | undefined> = {
  PATH: env['PATH'], LANG: env['LANG'], TMPDIR: env['TMPDIR'], SystemRoot: env['SystemRoot'],
  HOME: dirs.home, PI_CODING_AGENT_DIR: dirs.agent, PI_CODING_AGENT_SESSION_DIR: dirs.sessions, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
  PI_ACTIVE_VAULTS_CONFIG: dirs.config, PI_ACTIVE_VAULTS_STATE: dirs.state,
  ...(env['PAV_SMOKE_API_KEY'] === undefined ? {} : { PAV_SMOKE_API_KEY: env['PAV_SMOKE_API_KEY'] }),
};
const host: Host = {
  os: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
  env: Object.fromEntries(Object.entries(machineEnv).filter((e): e is [string, string] => e[1] !== undefined)),
  home: dirs.home, user: userInfo().username, hostname: hostname(),
};

function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  return runCli(argv, {
    write: (_stream, text) => { out += text; }, readStdin: async () => undefined, cwd: dirs.vault, host,
  }).then((code) => ({ code, out }));
}

interface Run {
  readonly document: string;
  /** How it finished, as the daemon told it. */
  readonly finished?: Notice;
  readonly commit?: string;
  readonly trailers?: string;
  readonly record?: unknown;
  readonly forked?: string | null;
}

async function main(): Promise<number> {
  // Accepting the vault as created is the owner's first act: shown the delta, they acknowledge its concerns.
  const tip = git(dirs.vault, 'rev-parse', 'main');
  const shown = await cli('accept', 'smoke', '--adopt', tip, '--json');
  const acknowledgement = (JSON.parse(shown.out.split('\n').find((l) => l.startsWith('{')) ?? '{}') as { data?: { delta?: { acknowledgement?: string } } }).data?.delta?.acknowledgement;
  const adopted = await cli('accept', 'smoke', '--adopt', tip, ...(acknowledgement === undefined ? [] : ['--acknowledge', acknowledgement]), '--yes');
  if (adopted.code !== 0) throw new Error(`adopting the vault failed: ${adopted.out}`);

  const daemon = await startDaemon({ host, pi: { file: process.execPath, args: [PI_CLI] }, env: machineEnv });
  if (!daemon.ok) throw new Error(`the daemon did not start: ${JSON.stringify(daemon.error)}`);
  const finished = new Map<string, Notice>();
  const bothFinished = new Promise<void>((done) => {
    daemon.value.automation.watch((notice) => {
      if (notice.state !== 'finished') return;
      finished.set(notice.document, notice);
      if (finished.has('jobs/first.md') && finished.has('jobs/second.md')) done();
    });
  });

  try {
    const triggered = await cli('trigger', 'smoke', '--vault', 'smoke');
    process.stdout.write(`vault trigger smoke: exit ${triggered.code}\n${triggered.out}`);
    const timedOut = new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), timeoutMs).unref());
    const ended = await Promise.race([bothFinished.then(() => 'done' as const), timedOut]);
    if (ended === 'timeout') process.stdout.write(`Timed out after ${timeoutMs / 1000}s; reporting what finished.\n`);
  } finally {
    await daemon.value.stop();
  }
  return report(finished);
}

function runOf(document: string, notice: Notice | undefined): Run {
  if (notice === undefined) return { document };
  const commit = notice.commit;
  const daemonLog = readFullLog(join(dirs.state, 'logs'), notice.trace).filter((l) => l.name === 'daemon')
    .flatMap((l) => l.text.trim().split('\n')).map((l) => JSON.parse(l) as { event?: string; fork?: string | null });
  const started = daemonLog.find((l) => l.event === 'started');
  if (commit === undefined) return { document, finished: notice, ...(started === undefined ? {} : { forked: started.fork ?? null }) };
  let record: unknown;
  try {
    record = JSON.parse(git(dirs.vault, 'notes', `--ref=${TRACES_REF}`, 'show', commit));
  } catch {
    record = undefined;
  }
  return {
    document, finished: notice, commit, trailers: git(dirs.vault, 'log', '-1', '--format=%(trailers)', commit), record,
    ...(started === undefined ? {} : { forked: started.fork ?? null }),
  };
}

async function report(finished: ReadonlyMap<string, Notice>): Promise<number> {
  const runs = ['jobs/first.md', 'jobs/second.md'].map((d) => runOf(d, finished.get(d)));
  for (const run of runs) {
    const f = run.finished;
    process.stdout.write(`\n${run.document}: ${f === undefined ? 'did not finish' : `${f.outcome ?? 'finished'}${f.reason === undefined ? '' : ` (${f.reason})`}, trace ${f.trace}`}\n`);
    if (run.forked !== undefined) process.stdout.write(`  forked from: ${run.forked ?? 'nothing (a fresh session)'}\n`);
    if (run.commit !== undefined) process.stdout.write(`  commit ${run.commit}\n  trailers:\n${(run.trailers ?? '').split('\n').map((l) => `    ${l}`).join('\n')}\n  trace record: ${JSON.stringify(run.record)}\n`);
  }
  const first = runs[0];
  if (first?.finished !== undefined) {
    const traced = await cli('trace', first.finished.trace);
    process.stdout.write(`\nvault trace ${first.finished.trace}: exit ${traced.code}\n${traced.out}`);
  }
  const [a, b] = runs;
  const passed = a?.commit !== undefined && a.record !== undefined && b?.commit !== undefined && typeof b.forked === 'string';
  process.stdout.write(`\n${passed ? 'PASS' : 'FAIL'}: ${passed ? 'both runs committed with their records, the second forked from the first\'s session' : 'see above'}.\n`);
  process.stdout.write(env['PAV_SMOKE_KEEP'] === '1' ? `Kept: ${box}\n` : '');
  return passed ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (error) {
  process.stderr.write(`npm run smoke: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  if (env['PAV_SMOKE_KEEP'] !== '1') rmSync(box, { recursive: true, force: true });
}
process.exit(code);
