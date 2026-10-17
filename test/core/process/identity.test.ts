// Documented behaviour: concepts.md "Actor" and daemon.md "Start-up recovery" —
// a process is identified by its ID and its start time, so a process ID the
// system has reused for another process never counts as the one recorded.
// A process that no longer exists is known to have ended before anything is
// asked about it, so a vanished holder never stands on any platform; only a
// process that exists can leave its start time unknown. The running platform
// is exercised for real; each platform's way of asking is exercised through
// injected answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processStartTime, runProcess, systemProcessProbe, type ProcessProbe, type ProcessRequest } from '../../../src/core/process/index.ts';

const linuxOnly = { skip: process.platform === 'linux' ? false : 'reads /proc' };

async function endedChildPid(): Promise<number> {
  const child = await runProcess({ program: { file: process.execPath, args: ['-e', 'console.log(process.pid)'] }, env: {}, timeoutMs: 10_000, maxStdoutBytes: 1024, maxStderrBytes: 1024 });
  assert.ok(child.ok);
  return Number(child.value.stdout.toString().trim());
}

test('the current process has a start time that stays the same; a process that has ended has none', linuxOnly, async () => {
  const first = await processStartTime(process.pid);
  const second = await processStartTime(process.pid);
  assert.ok(first.ok && typeof first.value === 'string');
  assert.deepEqual(second, first);
  assert.deepEqual(await processStartTime(await endedChildPid()), { ok: true, value: undefined });
});

test('the system probe tells an existing process from one that has ended', async () => {
  assert.equal(systemProcessProbe.exists(process.pid), 'exists');
  assert.equal(systemProcessProbe.exists(await endedChildPid()), 'gone');
});

type Existence = ReturnType<ProcessProbe['exists']>;

function probe(
  platform: NodeJS.Platform,
  answers: {
    files?: Record<string, string>;
    run?: (request: ProcessRequest) => { exitCode: number; stdout: string } | 'cannot-start';
    exists?: Existence;
    env?: Record<string, string>;
  },
): ProcessProbe {
  return {
    platform,
    env: answers.env ?? { SystemRoot: 'C:\\Windows' },
    exists: () => answers.exists ?? 'exists',
    readFile: (path) => answers.files?.[path],
    run: async (request) => {
      const answer = answers.run?.(request) ?? 'cannot-start';
      if (answer === 'cannot-start') return { ok: false, error: { reason: 'cannot-start', code: 'ENOENT' } };
      return { ok: true, value: { exitCode: answer.exitCode, stdout: Buffer.from(answer.stdout), stderr: Buffer.alloc(0), timedOut: false, stdoutTruncated: false, stderrTruncated: false } };
    },
  };
}

test('on Linux the start time comes from /proc, with the boot it belongs to; a zombie has ended', async () => {
  const boot = '02617211-66c9-459c-9440-3d9ab934a54b';
  // A command name may itself contain spaces and parentheses.
  const stat = (state: string) => `4242 (my (odd) name) ${state} 1 4242 4242 0 -1 4194304 342 0 0 0 0 0 0 0 20 0 1 0 31121868 17498112 1124 18446744073709551615`;
  const files = { '/proc/sys/kernel/random/boot_id': `${boot}\n`, '/proc/4242/stat': stat('S') };
  assert.deepEqual(await processStartTime(4242, probe('linux', { files })), { ok: true, value: `linux:${boot}:31121868` });
  assert.deepEqual(await processStartTime(4242, probe('linux', { files: { ...files, '/proc/4242/stat': stat('Z') } })), { ok: true, value: undefined });
  assert.deepEqual(await processStartTime(4243, probe('linux', { files })), { ok: true, value: undefined });
  assert.deepEqual(await processStartTime(4242, probe('linux', { files: { ...files, '/proc/4242/stat': '4242 (x) S 1' } })), { ok: false, error: { reason: 'cannot-tell', pid: 4242 } });
});

test('on macOS the start time comes from ps, asked by exact process ID', async () => {
  const asked: string[][] = [];
  const answers = (exitCode: number, stdout: string) => probe('darwin', { run: (request) => {
    asked.push('file' in request.program ? [request.program.file, ...request.program.args] : []);
    return { exitCode, stdout };
  } });
  assert.deepEqual(await processStartTime(4242, answers(0, 'Sat Oct 17 22:16:11 2026\n')), { ok: true, value: 'darwin:Sat Oct 17 22:16:11 2026' });
  assert.deepEqual(asked[0], ['/bin/ps', '-o', 'lstart=', '-p', '4242']);
  assert.deepEqual(await processStartTime(4242, answers(1, '')), { ok: true, value: undefined });
  assert.deepEqual(await processStartTime(4242, probe('darwin', {})), { ok: false, error: { reason: 'cannot-tell', pid: 4242 } });
});

test('on Windows the start time comes from PowerShell, run by its absolute path under SystemRoot with the variables it needs', async () => {
  const asked: ProcessRequest[] = [];
  const answers = (exitCode: number, stdout: string, env?: Record<string, string>) => probe('win32', { ...(env === undefined ? {} : { env }), run: (request) => {
    asked.push(request);
    return { exitCode, stdout };
  } });
  const env = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Users\\alice\\AppData\\Local\\Temp', SECRET_TOKEN: 'not for PowerShell' };
  assert.deepEqual(await processStartTime(4242, answers(0, '638650000000000000\r\n', env)), { ok: true, value: 'win32:638650000000000000' });
  const [request] = asked;
  assert.ok(request !== undefined && 'file' in request.program);
  assert.equal(request.program.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.match(request.program.args.join(' '), /Get-Process -Id 4242\b/);
  assert.equal(request.env['SystemRoot'], 'C:\\Windows', 'PowerShell cannot start without SystemRoot');
  assert.equal(request.env['TEMP'], env.TEMP);
  assert.equal(request.env['SECRET_TOKEN'], undefined, 'only the variables PowerShell needs');
  assert.deepEqual(await processStartTime(4242, answers(1, '')), { ok: true, value: undefined });
  assert.deepEqual(await processStartTime(4242, answers(0, 'not a number')), { ok: false, error: { reason: 'cannot-tell', pid: 4242 } });
  const before = asked.length;
  assert.deepEqual(await processStartTime(4242, answers(0, '638650000000000000', {})), { ok: false, error: { reason: 'cannot-tell', pid: 4242 } });
  assert.equal(asked.length, before, 'without SystemRoot there is no PowerShell to run');
});

test('a process that no longer exists has ended, on every platform, without asking for its start time', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const gone = probe(platform, { exists: 'gone', run: () => assert.fail('asked'), files: { '/proc/sys/kernel/random/boot_id': 'b', '/proc/4242/stat': '4242 (x) S 1' } });
    assert.deepEqual(await processStartTime(4242, gone), { ok: true, value: undefined }, platform);
  }
});

test('when an existing process\'s start time cannot be read, that is cannot-tell, never "ended"', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    for (const exists of ['exists', 'unknown'] as const) {
      assert.deepEqual(await processStartTime(4242, probe(platform, { exists })), { ok: false, error: { reason: 'cannot-tell', pid: 4242 } }, `${platform}, ${exists}`);
    }
  }
});

test('only a positive whole process ID is ever asked about', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.deepEqual(await processStartTime(pid, probe('darwin', { run: () => assert.fail('asked') })), { ok: true, value: undefined });
  }
});
