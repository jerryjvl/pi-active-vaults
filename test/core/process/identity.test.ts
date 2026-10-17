// Documented behaviour: concepts.md "Actor" and daemon.md "Start-up recovery" —
// a process is identified by its ID and its start time, so a process ID the
// system has reused for another process never counts as the one recorded.
// The running platform is exercised for real; each platform's way of asking is
// exercised through injected answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processStartTime, runProcess, type ProcessProbe, type ProcessRequest } from '../../../src/core/process/index.ts';

const linuxOnly = { skip: process.platform === 'linux' ? false : 'reads /proc' };

test('the current process has a start time that stays the same; a process that has ended has none', linuxOnly, async () => {
  const first = await processStartTime(process.pid);
  const second = await processStartTime(process.pid);
  assert.ok(first.ok && typeof first.value === 'string');
  assert.deepEqual(second, first);

  const child = await runProcess({ program: { file: process.execPath, args: ['-e', 'console.log(process.pid)'] }, env: {}, timeoutMs: 10_000, maxStdoutBytes: 1024, maxStderrBytes: 1024 });
  assert.ok(child.ok);
  assert.deepEqual(await processStartTime(Number(child.value.stdout.toString().trim())), { ok: true, value: undefined });
});

function probe(platform: NodeJS.Platform, answers: { files?: Record<string, string>; run?: (request: ProcessRequest) => { exitCode: number; stdout: string } | 'cannot-start' }): ProcessProbe {
  return {
    platform,
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

test('on Windows the start time comes from PowerShell, asked by exact process ID', async () => {
  const asked: string[] = [];
  const answers = (exitCode: number, stdout: string) => probe('win32', { run: (request) => {
    if ('file' in request.program) asked.push(request.program.args.join(' '));
    return { exitCode, stdout };
  } });
  assert.deepEqual(await processStartTime(4242, answers(0, '638650000000000000\r\n')), { ok: true, value: 'win32:638650000000000000' });
  assert.match(asked[0] ?? '', /Get-Process -Id 4242\b/);
  assert.deepEqual(await processStartTime(4242, answers(1, '')), { ok: true, value: undefined });
  assert.deepEqual(await processStartTime(4242, answers(0, 'not a number')), { ok: false, error: { reason: 'cannot-tell', pid: 4242 } });
});

test('only a positive whole process ID is ever asked about', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN]) {
    assert.deepEqual(await processStartTime(pid, probe('darwin', { run: () => assert.fail('asked') })), { ok: true, value: undefined });
  }
});
