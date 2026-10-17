// Work operations: jobs, run, trigger, script, notify and trace. Running a
// job, triggering, and running a script are propagating actions — refused
// for a vault whose `main` has an unaccepted change; listing jobs and
// reading traces only read.
//
// Without the daemon, `run` and `trigger` claim their spawns in the state
// database (architecture.md "Degradation"); the daemon runs them.

import { documentConditions, matchConditions, narrowByScripts, type Candidate, type Match, type VaultEvent } from '../../conditions/index.ts';
import { parseBudget, type Budget } from '../../budgets/index.ts';
import { listRefs, readTextAt } from '../../git/index.ts';
import { isTraceId } from '../../ids/index.ts';
import { requireNoUnacceptedChange, type AcceptedMain } from '../../integrity/index.ts';
import { notifyBuiltin, sendNotification, testTransport } from '../../notify/index.ts';
import { enqueueSpawn, listSpawns, type SpawnEntry } from '../../queue/index.ts';
import type { RegisteredVault } from '../../registry/index.ts';
import { runScript } from '../../scripts/index.ts';
import { compactTracePath, newTraceId, parseCompactTrace, readFullLog, type CompactTrace } from '../../traces/index.ts';
import type { OperationContext } from '../context.ts';
import { locate } from '../locate.ts';
import { fromError, refused, succeeded } from '../messages.ts';
import type { Operation, OperationRequest } from '../types.ts';
import { notifyDeps, readingFrom, text, texts, theVault } from './common.ts';

/** A condition in a line: its event and what it filters on. */
function conditionText(condition: Candidate['conditions'][number]): string {
  const filters = [
    condition.schedule === undefined ? undefined : `schedule "${condition.schedule}"`,
    condition.name === undefined ? undefined : `name ${condition.name}`,
    condition.paths === undefined ? undefined : `paths ${condition.paths.join(', ')}`,
    condition.change === undefined ? undefined : `change ${condition.change.join(', ')}`,
    condition.labels === undefined ? undefined : `labels ${condition.labels.join(', ')}`,
    condition.actor === undefined ? undefined : `actor ${condition.actor.join(', ')}`,
    condition.script === undefined ? undefined : `script ${condition.script}`,
  ].filter((f) => f !== undefined);
  return `on ${condition.on}${filters.length === 0 ? '' : ` (${filters.join('; ')})`}`;
}

/** The documents of a vault that can spawn work, from its accepted main. */
async function jobsOf(context: OperationContext, vault: RegisteredVault, accepted: AcceptedMain) {
  const documents = await documentConditions(context.git, vault.path, accepted);
  if (!documents.ok) return documents;
  return {
    ok: true as const,
    value: documents.value
      .filter((d) => d.issues.length > 0 || d.conditions.some((c) => c.effect === 'spawn'))
      .map((d) => {
        const budget = d.conditions.some((c) => c.effect === 'spawn') ? parseBudget(d.budget) : undefined;
        return { ...d, budget: budget?.ok === true ? budget.value : undefined, issues: [...d.issues, ...(budget?.ok === false ? budget.error : [])] };
      }),
  };
}

export const jobsOperation: Operation = {
  name: 'jobs',
  summary: 'Jobs with their conditions, last run and pending runs',
  vault: 'many',
  surfaces: { cli: true, command: true, mcp: true, tool: 'codemode' },
  params: [],
  async run(context, request) {
    const lines: string[] = [];
    const listed = [];
    for (const vault of request.vaults) {
      const accepted = readingFrom(context, vault);
      if (!accepted.ok) {
        lines.push(`${vault.id}: nothing accepted yet`);
        continue;
      }
      const jobs = await jobsOf(context, vault, accepted.value);
      if (!jobs.ok) return fromError(jobs.error);
      const spawns = listSpawns(context.state, { vault: vault.id });
      for (const job of jobs.value) {
        const runs = spawns.filter((s) => s.document === job.path);
        const last = runs.reduce<SpawnEntry | undefined>((latest, s) => (latest === undefined || s.claimed > latest.claimed ? s : latest), undefined);
        const pending = runs.filter((s) => s.state === 'queued').length;
        listed.push({ vault: vault.id, document: job.path, conditions: job.conditions, budget: job.budget, issues: job.issues, last, pending });
        lines.push(`${vault.id}:${job.path}`);
        for (const condition of job.conditions.filter((c) => c.effect === 'spawn')) lines.push(`  ${conditionText(condition)}`);
        for (const issue of job.issues) lines.push(`  problem: ${issue.path}: ${issue.message}`);
        lines.push(`  last run: ${last === undefined ? 'never' : `${last.state} (claimed ${last.claimed}, trace ${last.trace})`}; pending: ${pending}`);
      }
    }
    return succeeded(lines.join('\n') || 'No jobs.', { jobs: listed });
  },
};

export const runOperation: Operation = {
  name: 'run',
  summary: 'Run a job now, outside its conditions',
  vault: 'one',
  surfaces: { cli: true, command: true, mcp: true },
  params: [{ name: 'document', kind: 'string', required: true, positional: true, vaultPath: true, description: 'The job document, as <vault-id>:<path>' }],
  async run(context, request) {
    const vault = theVault(request);
    const document = text(request.params, 'document') ?? '';
    const accepted = await requireNoUnacceptedChange(context.git, context.state, vault);
    if (!accepted.ok) return fromError(accepted.error);
    const jobs = await jobsOf(context, vault, accepted.value);
    if (!jobs.ok) return fromError(jobs.error);
    const job = jobs.value.find((j) => j.path === document);
    if (job === undefined) return refused(`${vault.id}:${document} is not a job on the accepted main: it has no spawn condition.`);
    if (job.budget === undefined) return refused(`${vault.id}:${document} cannot run:${job.issues.map((i) => `\n  ${i.path}: ${i.message}`).join('')}`);
    const { entry } = enqueueSpawn(context.state, { ids: context.ids, clock: context.clock, limits: context.installation.config.budgets }, {
      vault: vault.id, document, event: { kind: 'manual', id: newTraceId(context.ids) }, budget: job.budget,
    });
    return queuedOutcome([entry]);
  },
};

function queuedOutcome(entries: readonly SpawnEntry[], dropped: readonly string[] = []): ReturnType<typeof succeeded> {
  const lines = entries.map((e) => (e.state === 'queued'
    ? `Queued ${e.vault}:${e.document} as trace ${e.trace}; the daemon runs it.`
    : `${e.vault}:${e.document} was not queued: ${e.reason ?? e.state}.`));
  return succeeded([...(lines.length === 0 ? ['Nothing matched.'] : lines), ...dropped].join('\n'), { spawns: entries });
}

/** The vaults an event in `vault` reaches: its own, and those the installation subscribes to it. */
function reached(context: OperationContext, vault: RegisteredVault): RegisteredVault[] {
  const subscribers = context.installation.config.subscriptions.filter((s) => s.from === vault.id).map((s) => s.to);
  return context.installation.vaults.filter((v) => v.id === vault.id || subscribers.includes(v.id));
}

const MAX_PAYLOAD_BYTES = 64 * 1024;

export const triggerOperation: Operation = {
  name: 'trigger',
  summary: 'Emit an external event; matching jobs are queued',
  vault: 'one',
  surfaces: { cli: true, command: false, mcp: true },
  params: [
    { name: 'name', kind: 'string', required: true, positional: true, description: 'The event name, as conditions name it' },
    { name: 'payload', kind: 'string', file: true, description: 'JSON passed to the jobs with the event' },
  ],
  async run(context, request) {
    const vault = theVault(request);
    const raw = text(request.params, 'payload');
    let payload: unknown;
    if (raw !== undefined) {
      if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) return refused(`The payload is larger than ${MAX_PAYLOAD_BYTES} bytes.`);
      try {
        payload = JSON.parse(raw);
      } catch {
        return refused('The payload is not JSON.');
      }
    }
    const event: VaultEvent = { kind: 'external', vault: vault.id, name: text(request.params, 'name') ?? '', ...(payload === undefined ? {} : { payload }) };
    const candidates: Candidate[] = [];
    const budgets = new Map<string, Budget>(); // every candidate has one
    const paused: string[] = [];
    for (const target of reached(context, vault)) {
      const accepted = await requireNoUnacceptedChange(context.git, context.state, target);
      if (!accepted.ok) {
        paused.push(`Vault "${target.id}" is paused (unaccepted change); its jobs were not matched.`);
        continue;
      }
      const jobs = await jobsOf(context, target, accepted.value);
      if (!jobs.ok) return fromError(jobs.error);
      for (const job of jobs.value) {
        if (job.budget === undefined) continue;
        candidates.push({ vault: target.id, document: job.path, conditions: job.conditions });
        budgets.set(`${target.id}:${job.path}`, job.budget);
      }
    }
    const matched = matchConditions(event, candidates, { subscriptions: context.installation.config.subscriptions, equivalentLabels: context.installation.config.labels.equivalent });
    const options = await context.scriptOptions();
    const narrowed = await narrowByScripts(
      { git: context.git, store: context.state, locate: (id) => context.installation.vaults.find((v) => v.id === id) },
      { ...options, builtins: [] }, event, matched.filter((m: Match) => m.condition.effect === 'spawn'),
    );
    const id = newTraceId(context.ids);
    const entries = narrowed.kept.map((match) => enqueueSpawn(context.state, { ids: context.ids, clock: context.clock, limits: context.installation.config.budgets }, {
      vault: match.vault, document: match.document, condition: match.index, event: { ...event, id }, budget: budgets.get(`${match.vault}:${match.document}`) as Budget,
    }).entry);
    const dropped = narrowed.dropped.map((d) => `${d.match.vault}:${d.match.document}: its script did not match (${d.reason}).`);
    return queuedOutcome(entries, [...dropped, ...paused]);
  },
};

/** Where a script works: the caller's place in the vault (its checkout or an actor's worktree), else the vault's checkout. */
function scriptDirectory(request: OperationRequest, vault: RegisteredVault): string {
  const cwd = request.caller.cwd;
  const here = cwd === undefined ? undefined : locate([vault], cwd);
  return here === undefined || cwd === undefined ? vault.path : cwd;
}

export const scriptOperation: Operation = {
  name: 'script',
  summary: 'Run an approved script from the accepted main, or a built-in',
  vault: 'one',
  surfaces: { cli: true, command: false, mcp: true, tool: 'direct' },
  params: [
    { name: 'name', kind: 'string', required: true, positional: true, description: 'The script, or builtin:<name>' },
    { name: 'args', kind: 'strings', positional: true, passthrough: true, description: 'Its arguments' },
    { name: 'input', kind: 'string', stdin: true, surfaces: ['cli'], description: 'Its standard input' },
  ],
  async run(context, request) {
    const vault = theVault(request);
    const options = await context.scriptOptions();
    const trace = newTraceId(context.ids);
    const deps = notifyDeps(context, options.env);
    const input = text(request.params, 'input');
    const ran = await runScript({ git: context.git, store: context.state, vault }, text(request.params, 'name') ?? '', texts(request.params, 'args'), {
      ...options, kind: 'script', builtins: deps === undefined ? [] : [notifyBuiltin(deps, { trace })],
      cwd: scriptDirectory(request, vault), ...(input === undefined ? {} : { input }),
    });
    if (!ran.ok) return fromError(ran.error);
    const outcome = { ...ran.value, trace };
    const note = ran.value.timedOut ? '\n[timed out]' : ran.value.truncated ? '\n[output cut off]' : '';
    return { status: ran.value.exitCode === 0 && !ran.value.timedOut ? 'ok' : 'failed', text: `${ran.value.stdout}${ran.value.stderr === '' ? '' : `\n${ran.value.stderr}`}${note}`.trim(), data: outcome };
  },
};

export const notifyOperation: Operation = {
  name: 'notify',
  summary: 'Send a notification to a configured recipient alias; "test" checks the transport',
  vault: 'optional',
  surfaces: { cli: true, command: false, mcp: true },
  params: [
    { name: 'action', kind: 'string', positional: true, choices: ['test'], description: '"test" delivers a test message to --to at once' },
    { name: 'to', kind: 'string', required: true, description: 'A recipient alias from the installation config' },
    { name: 'subject', kind: 'string', description: 'The subject line' },
    { name: 'body', kind: 'string', stdin: true, description: 'The message text' },
    { name: 'key', kind: 'string', description: 'A deduplication key: a second message with it inside the cooldown is dropped' },
  ],
  async run(context, request) {
    const deps = notifyDeps(context, (await context.scriptOptions()).env);
    if (deps === undefined) return fromError({ reason: 'not-configured', what: 'notify' });
    const to = text(request.params, 'to') ?? '';
    if (text(request.params, 'action') === 'test') {
      const tested = await testTransport(deps, to);
      return tested.ok ? succeeded(`A test message was delivered to "${to}".`) : fromError(tested.error);
    }
    const subject = text(request.params, 'subject');
    if (subject === undefined) return refused('A subject is needed (--subject).');
    const key = text(request.params, 'key');
    const sent = await sendNotification(deps, { to, subject, body: text(request.params, 'body') ?? '', trace: newTraceId(context.ids), ...(key === undefined ? {} : { key }) });
    return sent.ok ? succeeded(`${sent.value.outcome} ${sent.value.messageId}`, sent.value) : fromError(sent.error);
  },
};

/** The trace's compact record: on the accepted main, main, or an actor branch, whichever has it first. */
async function findCompactTrace(context: OperationContext, vault: RegisteredVault, trace: string): Promise<CompactTrace | undefined> {
  const accepted = readingFrom(context, vault);
  const actors = await listRefs(context.git, vault.path, 'refs/heads/actor/');
  const revisions = [...(accepted.ok ? [accepted.value.sha] : []), 'refs/heads/main', ...(actors.ok ? actors.value.map((r) => r.ref) : [])];
  for (const revision of revisions) {
    const found = await readTextAt(context.git, vault.path, revision, compactTracePath(trace));
    if (!found.ok || found.value === undefined) continue;
    const parsed = parseCompactTrace(found.value);
    if (parsed.ok) return parsed.value;
  }
  return undefined;
}

export const traceOperation: Operation = {
  name: 'trace',
  summary: 'Show a trace: its compact record, and full detail while logs are kept',
  vault: 'many',
  surfaces: { cli: true, command: true, mcp: true },
  params: [{ name: 'id', kind: 'string', required: true, positional: true, description: 'The trace ID' }],
  async run(context, request) {
    const id = text(request.params, 'id') ?? '';
    if (!isTraceId(id)) return refused(`"${id}" is not a trace ID.`);
    const records = [];
    for (const vault of request.vaults) {
      const record = await findCompactTrace(context, vault, id);
      if (record !== undefined) records.push(record);
    }
    // Full logs are the machine's; through MCP they would show every vault's detail, so only local surfaces read them.
    const logs = request.caller.surface === 'mcp' ? [] : readFullLog(context.installation.paths.logs, id);
    if (records.length === 0 && logs.length === 0) return fromError({ reason: 'not-found', path: `trace ${id}` });
    const lines = records.flatMap((r) => [
      `${r.vault}: ${r.trigger.event}${r.trigger.document === undefined ? '' : ` ${r.trigger.document}`}; path ${[...r.path, r.trace].join(' → ')}`,
      ...r.sessions.map((s) => `  session ${s.actor}: ${s.outcome}${s.reason === undefined ? '' : ` (${s.reason})`}, ${s.tokens} tokens`),
      ...r.documents.map((d) => `  produced ${d}`),
      ...r.scripts.map((s) => `  script ${s.name}: exit ${s.exitCode ?? 'none'}`),
      ...r.judgements.map((j) => `  judgement ${j.name}: ${j.result}`),
    ]);
    if (logs.length > 0) lines.push(`Full logs: ${logs.map((l) => `${l.day}/${l.name}`).join(', ')}`);
    return succeeded(lines.join('\n'), { records, logs });
  },
};
