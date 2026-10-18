// Vault sessions for tests of the `sessions` module and the extension: a
// queued and started spawn to run headless, and a session opened in a test
// installation as a Pi session would open it. Process IDs are fakes the
// installation's injected liveness knows about.

import { enqueueSpawn, startSpawn, type SpawnEntry } from '../../src/core/queue/index.ts';
import { openSession, type RunContext, type SessionStart, type VaultSession } from '../../src/core/sessions/index.ts';
import type { TestInstallation } from './installation.ts';

/** This test's own process, and another session's, as the installation's liveness sees them. */
export const ME = 4242;
export const OTHER = 777;
export const RUNNING: Readonly<Record<number, string>> = { [ME]: '2026-01-01T00:00:00Z', [OTHER]: '2026-01-01T00:00:01Z' };

/** The holder record of the other session. */
export const OTHER_HOLDER = { process: { pid: OTHER, started: RUNNING[OTHER] as string }, session: 'other-session' };

/** The job document `startedSpawn` runs, on the accepted main. */
export const JOB = '---\napplies-when: [{ on: external, name: daily, effect: spawn }]\nbudget: { tokens: 5000, ttl: 10m }\nactor: gardener\n---\nRun the daily job.\n';

/** A spawn of `document` — committed and accepted as a job first — queued and started as the daemon would before running it. */
export function startedSpawn(t: TestInstallation, document = 'jobs/daily.md', tokens = 5000): SpawnEntry {
  t.repo.write(document, JOB);
  t.repo.commit(`job ${document}`);
  t.accept();
  const { entry } = enqueueSpawn(t.context.state, { ids: t.context.ids, clock: t.clock, limits: t.installation.config.budgets }, {
    vault: t.vault.id, document, event: { kind: 'manual', id: `M-${document}` }, budget: { tokens, ttlMs: 600_000 },
  });
  const started = startSpawn(t.context.state, t.clock, entry.id);
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  return started.value;
}

/** The run file the daemon would write for a started spawn. */
export function runOf(entry: SpawnEntry, actor = 'gardener'): RunContext {
  return { vault: entry.vault, document: entry.document, trace: entry.trace, actor, event: entry.event };
}

/** Opens a session in the vault's checkout, as `actor`, interactive unless a run is given. */
export async function openTestSession(t: TestInstallation, extra: Partial<SessionStart> = {}): Promise<VaultSession> {
  const opened = await openSession(t.context, { session: 'pi-session-1', pid: ME, cwd: t.repo.path, ...extra });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.value.session;
}
