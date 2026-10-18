// The daemon's work for tests: an automation over a test installation, or the
// daemon adapter itself (its options, or one started and stopped around a
// test), its headless sessions run by the fake `pi` (fake-pi.mjs) rather
// than a real Pi.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAutomation, type Automation, type AutomationOptions } from '../../src/core/automation/index.ts';
import { createGit } from '../../src/core/git/index.ts';
import { createIdSource } from '../../src/core/ids/index.ts';
import { startDaemon, type DaemonOptions, type RunningDaemon } from '../../src/daemon/daemon.ts';
import { ME } from './session.ts';
import type { TestInstallation } from './installation.ts';

export type FakePiAction = 'nothing' | 'commit' | 'hang' | 'crash' | 'refuse' | 'spend' | 'fail' | 'commit-then-fail' | 'recover';

export interface FakePi {
  readonly options: Pick<AutomationOptions, 'pi' | 'env'>;
  /** Each start of the fake, in order. */
  starts(): { argv: string[]; cwd: string; run?: Record<string, unknown>; pid: number }[];
}

const FAKE = fileURLToPath(new URL('./fake-pi.mjs', import.meta.url));

/** The fake Pi, doing `actions` per job document (or "*"), in the installation's environment. */
export function fakePi(t: TestInstallation, actions: Readonly<Record<string, FakePiAction>> = {}): FakePi {
  const log = t.dir.file('fake-pi.log');
  return {
    options: {
      pi: { file: process.execPath, args: [FAKE] },
      env: { ...t.host.env, FAKE_PI_ACTIONS: JSON.stringify(actions), FAKE_PI_LOG: log },
    },
    starts: () => {
      let text = '';
      try {
        text = readFileSync(log, 'utf8');
      } catch {
        return [];
      }
      return text.trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
    },
  };
}

/** An automation for `t` with the fake Pi, in UTC unless a time zone is given. */
export function automationFor(t: TestInstallation, pi: FakePi, options: Partial<AutomationOptions> = {}): Automation {
  return createAutomation(t.context, { ...pi.options, timeZone: 'UTC', version: '0.0.0-test', graceMs: 2000, ...options });
}

/** A job document: its conditions (YAML flow list), budget and actor. */
export function jobDocument(conditions: string, options: { ttl?: string; tokens?: number; actor?: string; body?: string } = {}): string {
  return `---\napplies-when: ${conditions}\nbudget: { tokens: ${options.tokens ?? 100000}, ttl: ${options.ttl ?? '10m'} }\nactor: ${options.actor ?? 'gardener'}\n---\n${options.body ?? 'Do the job.'}\n`;
}

/** What the daemon adapter starts with in tests: the installation's machine and services, the fake Pi, no timers or watching unless asked. */
export function daemonOptions(t: TestInstallation, pi: FakePi, extra: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    host: t.host, pid: ME, pi: pi.options.pi, env: pi.options.env, timeZone: 'UTC', ticks: false, watch: false,
    context: {
      git: createGit({ env: t.repo.env }), clock: t.clock, alive: t.context.alive, sandbox: 'none',
      ids: createIdSource({ clock: t.clock, randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }),
    },
    ...extra,
  };
}

/**
 * Runs `run` with the daemon adapter started on `t` — its socket, endpoints
 * and automation — and stops it after. `minute` is one minute of the
 * daemon's work as its timers would do it — a tick (forge sync, integrity,
 * Git events, timers, the outbox), then starting what can start — waited
 * out until its runs have ended.
 */
export async function withDaemon(
  t: TestInstallation, pi: FakePi, run: (daemon: RunningDaemon, minute: () => Promise<void>) => Promise<void>, extra: Partial<DaemonOptions> = {},
): Promise<void> {
  const started = await startDaemon(daemonOptions(t, pi, extra));
  if (!started.ok) throw new Error(`the daemon did not start: ${JSON.stringify(started.error)}`);
  const { automation } = started.value;
  try {
    await run(started.value, async () => {
      await automation.tick();
      await automation.schedule();
      await automation.idle();
    });
  } finally {
    await started.value.stop();
  }
}
