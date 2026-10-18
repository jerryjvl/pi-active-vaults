// A stand-in for `pi --mode rpc` in daemon tests — never a real Pi. It speaks
// just enough of Pi's RPC protocol (JSON lines: a `prompt` command answered
// by a `response`, then session events up to `agent_settled`; closing
// standard input ends it) and does what the test asks for the run's job:
//
//   FAKE_PI_ACTIONS  JSON: job document (or "*") → nothing | commit | hang | crash | refuse | spend
//   FAKE_PI_LOG      a file each start is appended to as a JSON line: argv, cwd, run file, pid
//
// `commit` writes `notes/<trace>.md` in its directory and commits it with the
// package's trailers, as a run's vault_commit would; `spend` uses the run's
// whole allotment in the state database, as a run past its budget would
// have; `refuse` exits at once, as a run the extension refuses does.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const runFile = flag('--vault-run');
const run = runFile === undefined ? undefined : JSON.parse(readFileSync(runFile, 'utf8'));
const actions = JSON.parse(process.env.FAKE_PI_ACTIONS ?? '{}');
const action = actions[run?.document] ?? actions['*'] ?? 'nothing';
if (process.env.FAKE_PI_LOG !== undefined) {
  appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ argv, cwd: process.cwd(), run, pid: process.pid })}\n`);
}

const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const settle = () => {
  send({ type: 'agent_end', messages: [] });
  send({ type: 'agent_settled', aborted: false });
};

function work() {
  switch (action) {
    case 'commit': {
      mkdirSync('notes', { recursive: true });
      writeFileSync(join('notes', `${run.trace}.md`), `# Done by ${run.trace}\n`);
      execFileSync('git', ['add', '--all'], { stdio: 'ignore' });
      execFileSync('git', ['commit', '--quiet', '-m', 'Run output', '-m', `Vault-Trace: ${run.trace}\nVault-Actor: ${run.actor}`], { stdio: 'ignore' });
      settle();
      return;
    }
    case 'spend': {
      const db = new DatabaseSync(join(process.env.PI_ACTIVE_VAULTS_STATE, 'state.sqlite'));
      db.prepare('UPDATE budgets_sessions SET used = allotted WHERE trace = ?').run(run.trace);
      db.close();
      process.exit(0);
      return;
    }
    case 'hang':
      return;
    case 'crash':
      process.exit(1);
      return;
    default:
      settle();
  }
}

if (action === 'refuse') process.exit(0);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
    const command = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (command.type === 'prompt') {
      send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      work();
    }
  }
});
process.stdin.on('end', () => process.exit(0));
