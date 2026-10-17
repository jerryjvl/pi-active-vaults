// Documented behaviour: core.md `process` — the one way the package starts a
// process: a program and an argument array, or an explicit shell command line;
// exactly the environment given; standard input closed unless input is given;
// bounded output; a time limit past which the process is killed with its
// process group on POSIX. Runs real processes (Node itself) on this platform;
// the other platforms' branch is the pure `ownProcessGroup`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { ownProcessGroup, runProcess, type ProcessRequest } from '../../../src/core/process/index.ts';
import { withTempDir } from '../../support/temp-dir.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX process groups and sh' : false };

function node(code: string, ...args: string[]): ProcessRequest['program'] {
  return { file: process.execPath, args: ['-e', code, ...args] };
}

function request(program: ProcessRequest['program'], overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return { program, env: {}, timeoutMs: 10_000, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 64 * 1024, ...overrides };
}

async function run(program: ProcessRequest['program'], overrides: Partial<ProcessRequest> = {}) {
  const ran = await runProcess(request(program, overrides));
  if (!ran.ok) assert.fail(`expected the process to start: ${JSON.stringify(ran.error)}`);
  return ran.value;
}

/** Whether `pid` is gone; a killed process may take a moment to be reaped, so this waits briefly. */
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0);
      const state = process.platform === 'linux' ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] : undefined;
      if (state === 'Z') return true; // dead, waiting for its parent to reap it
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('arguments are passed exactly as given, never through a shell', async () => {
  const tricky = ['$HOME', '; echo injected', '*', '"quoted"', ''];
  const ran = await run(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky));
  assert.deepEqual(JSON.parse(ran.stdout.toString('utf8')), tricky);
  assert.equal(ran.exitCode, 0);
});

test('a shell runs only when asked for explicitly, and then interprets the command line', async () => {
  const ran = await run({ shell: 'echo one&& echo two' }, { env: { PATH: process.env['PATH'] ?? '' } });
  assert.deepEqual(ran.stdout.toString('utf8').split(/\r?\n/).filter((l) => l !== '').map((l) => l.trim()), ['one', 'two']);
});

test('the environment is exactly the one given: nothing is inherited, and unset values are left out', async () => {
  const ran = await run(node('process.stdout.write(JSON.stringify(process.env))'), { env: { ONLY: 'this', UNSET: undefined } });
  const env = JSON.parse(ran.stdout.toString('utf8')) as Record<string, string>;
  // Windows adds a few variables of its own to every process.
  if (process.platform === 'win32') assert.equal(env['ONLY'], 'this');
  else assert.deepEqual(env, { ONLY: 'this' });
});

test('the process runs in the given directory', withTempDir(async (dir) => {
  const ran = await run(node('process.stdout.write(process.cwd())'), { cwd: dir.path });
  assert.equal(realpathSync(ran.stdout.toString('utf8')), realpathSync(dir.path));
}));

test('standard input is closed unless input is given, so nothing can wait on a prompt', async () => {
  const echo = node('let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>process.stdout.write("got:"+s))');
  assert.equal((await run(echo)).stdout.toString('utf8'), 'got:');
  assert.equal((await run(echo, { input: 'some input' })).stdout.toString('utf8'), 'got:some input');
});

test('the exit status and both output streams are reported', async () => {
  const ran = await run(node('process.stdout.write("out");process.stderr.write("err");process.exit(3)'));
  assert.deepEqual(
    [ran.exitCode, ran.stdout.toString('utf8'), ran.stderr.toString('utf8'), ran.timedOut, ran.stdoutTruncated, ran.stderrTruncated],
    [3, 'out', 'err', false, false, false],
  );
});

test('output beyond each stream\'s limit is cut off and reported, and a zero limit keeps nothing', async () => {
  const loud = node('process.stdout.write("x".repeat(5000));process.stderr.write("y".repeat(5000))');
  const ran = await run(loud, { maxStdoutBytes: 1000, maxStderrBytes: 0 });
  assert.equal(ran.stdout.length, 1000);
  assert.equal(ran.stderr.length, 0);
  assert.deepEqual([ran.stdoutTruncated, ran.stderrTruncated, ran.exitCode], [true, true, 0]);
});

test('a process past its time limit is killed and reported as timed out', async () => {
  const ran = await run(node('setTimeout(() => {}, 30_000)'), { timeoutMs: 100 });
  assert.deepEqual([ran.timedOut, ran.exitCode], [true, null]);
});

test('on POSIX a timeout kills everything the process started, even what holds its output open', posixOnly, async () => {
  const ran = await run({ shell: 'sleep 30 & echo $!; wait' }, { env: { PATH: process.env['PATH'] ?? '' }, timeoutMs: 200 });
  assert.equal(ran.timedOut, true);
  const grandchild = Number(ran.stdout.toString('utf8').trim());
  assert.ok(grandchild > 0, 'the background process reported its pid');
  assert.ok(await gone(grandchild), 'the background process was killed with its group');
});

test('a program that cannot be started is an error value, not an exception', async () => {
  const ran = await runProcess(request({ file: '/nonexistent/program', args: [] }));
  assert.deepEqual(ran, { ok: false, error: { reason: 'cannot-start', code: 'ENOENT' } });
});

test('a process leads its own group on Linux and macOS, so it can be killed with what it started; not on Windows', () => {
  assert.equal(ownProcessGroup('linux'), true);
  assert.equal(ownProcessGroup('darwin'), true);
  assert.equal(ownProcessGroup('win32'), false);
});
