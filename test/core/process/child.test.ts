// Documented behaviour: core.md "process" — the one way to start a process,
// here a long-lived one (the daemon's `pi --mode rpc` sessions): an argument
// array, exactly the environment given, its output read as JSON lines split
// on line feeds only (Pi's RPC framing), killed with its process group on
// POSIX. daemon.md "Start-up recovery" — a session left from a previous run
// is ended by the exact process ID recorded, after checking that process's
// start time, so a reused ID is never touched; never by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endProcess, processStartTime, startChild } from '../../../src/core/process/index.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'process groups are POSIX' : false };
const node = (script: string) => ({ file: process.execPath, args: ['-e', script] });
const ENV = { PATH: process.env['PATH'] };
const running = async (pid: number): Promise<boolean> => {
  const start = await processStartTime(pid);
  return start.ok && start.value !== undefined;
};

test('a child\'s output arrives line by line, split on line feeds only; what it is sent arrives', async () => {
  const started = await startChild({
    program: node(`process.stdin.on('data', (d) => { process.stdout.write('got ' + d.toString().trim() + '\\nwith\\u2028separator\\r\\n'); process.exit(3); });`),
    env: ENV,
  });
  assert.ok(started.ok);
  const child = started.value;
  const lines: string[] = [];
  child.onLine((line) => lines.push(line));
  child.write('{"type":"prompt"}\n');
  const exit = await child.exited;
  assert.equal(exit.exitCode, 3);
  assert.deepEqual(lines, ['got {"type":"prompt"}', 'with separator']);
});

test('nothing of the caller\'s environment reaches a child but what it is given', async () => {
  process.env['PAV_SECRET_FOR_TEST'] = 'leak';
  try {
    const started = await startChild({ program: node('console.log(JSON.stringify(process.env.PAV_SECRET_FOR_TEST ?? null)); console.log(process.env.GIVEN)'), env: { ...ENV, GIVEN: 'yes' } });
    assert.ok(started.ok);
    const lines: string[] = [];
    started.value.onLine((line) => lines.push(line));
    await started.value.exited;
    assert.deepEqual(lines, ['null', 'yes']);
  } finally {
    delete process.env['PAV_SECRET_FOR_TEST'];
  }
});

test('a program that cannot start is a value, not a crash', async () => {
  const started = await startChild({ program: { file: '/nonexistent/pi', args: [] }, env: ENV });
  assert.deepEqual(!started.ok && started.error.reason, 'cannot-start');
});

test('killing a child ends what it started too', posixOnly, async () => {
  const started = await startChild({ program: node(`const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`), env: ENV });
  assert.ok(started.ok);
  const grandchild = await new Promise<number>((resolve) => started.value.onLine((line) => resolve(Number(line))));
  started.value.kill();
  await started.value.exited;
  // The kill is immediate; the system takes a moment to reap the grandchild.
  for (let i = 0; i < 100 && (await running(grandchild)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await running(grandchild), false, 'the grandchild is gone');
});

test('a recorded process is ended only when its start time is the one recorded', async () => {
  const started = await startChild({ program: node('setInterval(() => {}, 1000)'), env: ENV });
  assert.ok(started.ok);
  const { pid } = started.value;
  const start = await processStartTime(pid);
  assert.ok(start.ok && start.value !== undefined);
  assert.equal(await endProcess({ pid, started: 'some-other-process' }), 'not-that-process', 'a reused ID is never touched');
  assert.equal(await running(pid), true);
  assert.equal(await endProcess({ pid, started: start.value }), 'ended');
  await started.value.exited;
  assert.equal(await endProcess({ pid, started: start.value }), 'gone');
});
