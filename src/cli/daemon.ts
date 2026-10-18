// `vault daemon …` (cli.md "Daemon"): CLI-only commands that control
// processes, so they are not operations of the catalogue. Each is a thin
// step: the definitions, the daemon and its protocol are the core's.
//
//   install     write the platform's service definition and register it
//   start/stop  ask the service manager
//   status      ask the running daemon (exit 1 when there is none)
//   run         run the daemon in the foreground until signalled
//   print-unit  print the service definition, for declarative setups
//
// `--headless` (macOS) is the launchd daemon for a Mac nobody logs in to. It
// lives in the system domain, so installing, starting and stopping it need
// administrator rights the package never asks for: `print-unit --headless`
// prints it, and the other commands say what to run with sudo.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findServiceTools, serviceFor, type ServiceDefinition, type ServiceProgram } from '../core/config/index.ts';
import { loadInstallation, describeError, openStateStore } from '../core/operations/index.ts';
import { recordServiceTools } from '../core/queue/index.ts';
import { systemClock } from '../core/clock/index.ts';
import { runProcess } from '../core/process/index.ts';
import { isRecord } from '../core/result/index.ts';
import { requestOverSocket } from '../core/socket/index.ts';
import { startDaemon, type DaemonOptions } from '../daemon/daemon.ts';
import { CLI_PROGRAM } from './program.ts';
import type { CliIo } from './run.ts';

const EXIT = { ok: 0, failed: 1, invalid: 2 } as const;
const COMMANDS = ['install', 'start', 'stop', 'status', 'run', 'print-unit'] as const;

/** Runs a service manager's command, as given, with the user's environment; its exit status. */
async function systemRun(io: CliIo, program: ServiceProgram): Promise<number> {
  const ran = await runProcess({ program, env: io.host.env, timeoutMs: 60_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 });
  if (!ran.ok) return 127;
  const output = `${ran.value.stdout.toString('utf8')}${ran.value.stderr.toString('utf8')}`.trim();
  if (output !== '') io.write('stderr', `${output}\n`);
  return ran.value.exitCode ?? 1;
}

async function runAll(io: CliIo, programs: readonly ServiceProgram[]): Promise<number> {
  for (const program of programs) {
    const code = await (io.runProgram ?? ((p) => systemRun(io, p)))(program);
    if (code !== 0) {
      io.write('stderr', `vault daemon: ${[program.file, ...program.args].join(' ')} exited ${code}.\n`);
      return EXIT.failed;
    }
  }
  return EXIT.ok;
}

function statusText(status: unknown): string {
  if (!isRecord(status)) return 'The daemon runs.';
  const queued = Array.isArray(status['queued']) ? status['queued'] : [];
  const running = Array.isArray(status['running']) ? status['running'] : [];
  const paused = Array.isArray(status['paused']) ? status['paused'] : [];
  const forge = Array.isArray(status['forge']) ? status['forge'].filter(isRecord) : [];
  const line = (s: unknown): string => (isRecord(s) ? `  ${String(s['vault'])}:${String(s['document'])} (trace ${String(s['trace'])})` : '');
  return [
    `The daemon runs: ${queued.length} queued, ${running.length} running.`,
    ...running.map((s) => `${line(s)} running`),
    ...queued.map((s) => `${line(s)} queued`),
    ...(paused.length === 0 ? [] : [`Paused (unaccepted change): ${paused.join(', ')}`]),
    ...forge.map((f) => `Forge ${String(f['vault'])}: ${f['error'] === undefined ? 'synced' : `failed (${String(f['error'])})`} at ${String(f['at'])}${Array.isArray(f['proposed']) && f['proposed'].length > 0 ? `; proposing ${f['proposed'].join(', ')}` : ''}`),
  ].join('\n');
}

export async function runDaemonCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const [, command, ...options] = argv;
  const known = COMMANDS.find((c) => c === command);
  const headless = options.includes('--headless');
  if (known === undefined || options.some((o) => o !== '--headless')) {
    io.write('stderr', `Usage: vault daemon ${COMMANDS.join('|')} [--headless]\n`);
    return EXIT.invalid;
  }
  if (headless && (known === 'status' || known === 'run')) {
    io.write('stderr', `vault daemon ${known}: --headless is only for install, start, stop and print-unit.\n`);
    return EXIT.invalid;
  }
  const installation = loadInstallation(io.host);
  if (!installation.ok) {
    io.write('stderr', `vault: the installation cannot be loaded. ${describeError(installation.error)}\n`);
    return EXIT.failed;
  }
  const { paths } = installation.value;

  if (known === 'status') {
    const status = await requestOverSocket(paths.socket, 'status', {});
    if (!status.ok) {
      io.write('stderr', status.error.reason === 'not-running' ? 'No daemon is running; "vault daemon start" starts the installed service.\n' : `The daemon did not answer (${status.error.reason}).\n`);
      return EXIT.failed;
    }
    io.write('stdout', `${statusText(status.value)}\n`);
    return EXIT.ok;
  }

  if (known === 'run') {
    const options: DaemonOptions = { host: io.host, ...(io.context === undefined ? {} : { context: io.context }), ...io.daemon };
    const daemon = await startDaemon(options);
    if (!daemon.ok) {
      const { error } = daemon;
      if (error.reason === 'already-running' || error.reason === 'in-use') {
        // Not a failure: one daemon runs, as it should; a service manager need not restart this one.
        io.write('stderr', `vault daemon: a daemon already runs${error.reason === 'already-running' ? ` (process ${error.pid})` : ''}; this one does not.\n`);
        return EXIT.ok;
      }
      io.write('stderr', `vault daemon: it cannot start (${error.reason}).\n`);
      return EXIT.failed;
    }
    io.write('stderr', `vault daemon: running${daemon.value.recovered.stopped.length === 0 ? '' : `; ${daemon.value.recovered.stopped.length} run(s) left running before were stopped`}.\n`);
    for (const endpoint of daemon.value.endpoints) {
      io.write('stderr', 'address' in endpoint
        ? `vault daemon: MCP profile "${endpoint.profile}" at ${endpoint.address}.\n`
        : `vault daemon: MCP profile "${endpoint.profile}" is not served (${endpoint.error.reason}${'where' in endpoint.error ? ` in ${endpoint.error.where}` : ''}).\n`);
    }
    await (io.until ?? new Promise<void>(() => {}));
    await daemon.value.stop();
    return EXIT.ok;
  }

  // Where node, pi and git are now: the service is given that PATH, and `install` records it.
  const tools = findServiceTools(io.host);
  const service = serviceFor(io.host, CLI_PROGRAM, {
    state: dirname(paths.stateDb), headless, tools, ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
  });
  if (!service.ok && service.error.reason === 'not-supported') {
    io.write('stderr', 'vault daemon: --headless is for macOS, where a launchd daemon runs the daemon on a Mac nobody logs in to.\n');
    return EXIT.invalid;
  }
  if (!service.ok) {
    io.write('stderr', `vault daemon: the service cannot be defined (${service.error.reason}).\n`);
    return EXIT.failed;
  }
  const definition: ServiceDefinition = service.value;
  if (headless && known !== 'print-unit') {
    const sudo = (programs: readonly ServiceProgram[]): string[] => programs.map((p) => `  sudo ${[p.file, ...p.args].join(' ')}`);
    const steps = known === 'install'
      ? [`  vault daemon print-unit --headless | sudo tee ${definition.file} >/dev/null`, ...sudo(definition.commands.install)]
      : sudo(definition.commands[known]);
    io.write('stderr', `vault daemon: the headless daemon is the system's, so this needs administrator rights. Run:\n${steps.join('\n')}\n`);
    return EXIT.invalid;
  }
  switch (known) {
    case 'print-unit':
      io.write('stdout', definition.text);
      return EXIT.ok;
    case 'install': {
      mkdirSync(dirname(definition.file), { recursive: true });
      writeFileSync(definition.file, definition.encoding === 'utf16le' ? `﻿${definition.text}` : definition.text, { encoding: definition.encoding });
      const code = await runAll(io, definition.commands.install);
      if (code !== EXIT.ok) return code;
      const state = openStateStore(paths);
      if (!state.ok) {
        io.write('stderr', `vault daemon: installed, but the state database cannot be opened to record the service's PATH (${state.error.reason}); "vault doctor" cannot warn when it goes stale.\n`);
        return EXIT.failed;
      }
      try {
        recordServiceTools(state.value, tools, io.context?.clock ?? systemClock);
      } finally {
        state.value.close();
      }
      io.write('stdout', `Installed ${definition.file}; "vault daemon start" starts it, and it starts at login. Its PATH begins with ${tools.map((t) => `${t.dir} (${t.tool})`).join(', ') || 'nothing found: node, pi and git are on no PATH directory'}.\n`);
      return code;
    }
    case 'start':
      return runAll(io, definition.commands.start);
    case 'stop':
      return runAll(io, definition.commands.stop);
  }
}
