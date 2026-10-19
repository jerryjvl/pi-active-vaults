// Vault sessions for tests of the `sessions` module and the extension: a
// queued and started spawn to run headless, the run file the daemon would
// write for it, and a session opened in a test installation as a Pi session
// would open it. Process IDs are fakes the installation's injected liveness
// knows about.

import { writeFileSync } from 'node:fs';
import { queueContext } from '../../src/core/operations/index.ts';
import { enqueueSpawn, startSpawn, type SpawnEntry } from '../../src/core/queue/index.ts';
import { openSession, renderRunContext, type RunContext, type SessionStart, type VaultSession } from '../../src/core/sessions/index.ts';
import type { TestInstallation } from './installation.ts';
import { AGENT_MODEL } from './models.ts';

/** This test's own process, and another session's, as the installation's liveness sees them. */
export const ME = 4242;
export const OTHER = 777;
export const RUNNING: Readonly<Record<number, string>> = { [ME]: '2026-01-01T00:00:00Z', [OTHER]: '2026-01-01T00:00:01Z' };

/** The holder record of the other session. */
export const OTHER_HOLDER = { process: { pid: OTHER, started: RUNNING[OTHER] as string }, session: 'other-session' };

/** The job document `startedSpawn` runs, on the accepted main; its budget is ample for a few turns (tests of budgets give their own). */
export const JOB = '---\napplies-when: [{ on: external, name: daily, effect: spawn }]\nbudget: { tokens: 20000, ttl: 10m }\nactor: gardener\n---\nRun the daily job.\n';

/**
 * A spawn of `document` — committed and accepted as a job first — queued and
 * started as the daemon would before running it; in the tree of `parent`
 * when given.
 */
export function startedSpawn(t: TestInstallation, document = 'jobs/daily.md', tokens = 20000, parent?: string): SpawnEntry {
  t.repo.write(document, JOB);
  t.repo.commit(`job ${document}`);
  t.accept();
  const { entry } = enqueueSpawn(t.context.state, queueContext(t.context), {
    vault: t.vault.id, document, event: { kind: 'manual', id: `M-${document}` }, budget: { tokens, ttlMs: 600_000 }, actor: 'gardener',
    ...(parent === undefined ? {} : { parent }),
  });
  const started = startSpawn(t.context.state, t.clock, entry.id);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  return started.value;
}

/** The run file the daemon would write for a started spawn. */
export function runOf(entry: SpawnEntry, actor = 'gardener'): RunContext {
  return { vault: entry.vault, document: entry.document, trace: entry.trace, actor, model: entry.model ?? 'agent', event: entry.event };
}

/** Writes the run file for `entry` (with `overrides`, or as `raw` text) and returns its path. */
export function runFileFor(t: TestInstallation, entry: SpawnEntry, overrides: Record<string, unknown> = {}): string {
  const path = t.dir.file(`run-${entry.trace}.json`);
  writeFileSync(path, overrides['raw'] === undefined ? renderRunContext({ ...runOf(entry), ...overrides }) : String(overrides['raw']));
  return path;
}

/** Opens a session in the vault's checkout, as `actor`, interactive unless a run is given. */
export async function openTestSession(t: TestInstallation, extra: Partial<SessionStart> = {}): Promise<VaultSession> {
  const opened = await openSession(t.context, { session: 'pi-session-1', pid: ME, cwd: t.repo.path, model: AGENT_MODEL, ...extra });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.value.session;
}
