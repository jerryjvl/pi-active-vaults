// Work operations: jobs, run, trigger, script, notify and trace. Running a
// job, triggering, and running a script are propagating actions — refused
// for a vault whose `main` has an unaccepted change; listing jobs and
// reading traces only read.
//
// Without the daemon, `run` and `trigger` claim their spawns in the state
// database (architecture.md "Degradation"); the daemon runs them.

import type { Candidate, VaultEvent } from '../../conditions/index.ts';
import { listRefs } from '../../git/index.ts';
import { isTraceId } from '../../ids/index.ts';
import { requireNoUnacceptedChange } from '../../integrity/index.ts';
import { notifyBuiltin, sendNotification, testTransport } from '../../notify/index.ts';
import { enqueueSpawn, listSpawns, vaultJobs, type MatchedSpawns, type SpawnEntry } from '../../queue/index.ts';
import type { RegisteredVault } from '../../registry/index.ts';
import { runScript } from '../../scripts/index.ts';
import { newTraceId, readFullLog, runCommits, type CompactTrace, type RunCommit } from '../../traces/index.ts';
import type { OperationContext } from '../context.ts';
import { locate } from '../locate.ts';
import { fromError, invalid, refused, succeeded } from '../messages.ts';
import type { Operation, OperationRequest } from '../types.ts';
import { hasSpawnCondition, jobModel, unavailableText } from '../models.ts';
import { queueContext, requestSpawns, spawnLines } from '../spawning.ts';
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
      const jobs = await vaultJobs(context.git, vault.path, accepted.value, context.reads);
      if (!jobs.ok) return fromError(jobs.error);
      const spawns = listSpawns(context.state, { vault: vault.id });
      for (const job of jobs.value) {
        const runs = spawns.filter((s) => s.document === job.path);
        const last = runs.reduce<SpawnEntry | undefined>((latest, s) => (latest === undefined || s.claimed > latest.claimed ? s : latest), undefined);
        const pending = runs.filter((s) => s.state === 'queued').length;
        const model = hasSpawnCondition(job) ? jobModel(context.installation.config, vault.id, job) : undefined;
        listed.push({
          vault: vault.id, document: job.path, conditions: job.conditions, budget: job.budget, issues: job.issues, last, pending,
          ...(model === undefined ? {} : model.ok ? { model: { name: model.value.name, model: model.value.entry.model } } : { noModel: model.error }),
        });
        lines.push(`${vault.id}:${job.path}`);
        for (const condition of job.conditions.filter((c) => c.effect === 'spawn')) lines.push(`  ${conditionText(condition)}`);
        for (const issue of job.issues) lines.push(`  problem: ${issue.path}: ${issue.message}`);
        // The default needs no mention; a model the job asks for, or that cannot be had, does.
        if (model?.ok === false) lines.push(`  problem: no agent model it may use (${unavailableText(model.error)})`);
        else if (model !== undefined && job.model !== undefined) lines.push(`  model: ${model.value.name}${model.value.substitutedFor === undefined ? '' : ` (asked for "${model.value.substitutedFor}", which is not configured)`}`);
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
    const jobs = await vaultJobs(context.git, vault.path, accepted.value, context.reads);
    if (!jobs.ok) return fromError(jobs.error);
    const job = jobs.value.find((j) => j.path === document);
    if (job === undefined) return refused(`${vault.id}:${document} is not a job on the accepted main: it has no spawn condition.`);
    if (job.terms === undefined) return refused(`${vault.id}:${document} cannot run:${job.issues.map((i) => `\n  ${i.path}: ${i.message}`).join('')}`);
    const { entry } = enqueueSpawn(context.state, queueContext(context), {
      vault: vault.id, document, event: { kind: 'manual', id: newTraceId(context.ids) }, ...job.terms,
    });
    return queuedOutcome([entry]);
  },
};

function queuedOutcome(entries: readonly SpawnEntry[], matched: Pick<MatchedSpawns, 'dropped' | 'paused'> = { dropped: [], paused: [] }): ReturnType<typeof succeeded> {
  const lines = spawnLines(entries, matched);
  return succeeded((entries.length === 0 ? ['Nothing matched.', ...lines] : lines).join('\n'), { spawns: entries });
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
        return invalid('The payload is not JSON.');
      }
    }
    const event: VaultEvent = { kind: 'external', vault: vault.id, name: text(request.params, 'name') ?? '', ...(payload === undefined ? {} : { payload }) };
    const requested = await requestSpawns(context, { event, id: newTraceId(context.ids) });
    if (!requested.ok) return fromError(requested.error);
    return queuedOutcome(requested.value.entries, requested.value.matched);
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
    // A session's script runs are part of its run: what they send is recorded in its trace.
    const trace = request.caller.trace ?? newTraceId(context.ids);
    const deps = notifyDeps(context, options.env);
    const input = text(request.params, 'input');
    const ran = await runScript({ git: context.git, store: context.state, vault }, text(request.params, 'name') ?? '', texts(request.params, 'args'), {
      ...options, kind: 'script', builtins: deps === undefined ? [] : [notifyBuiltin(deps, { trace })],
      cwd: scriptDirectory(request, vault), ...(input === undefined ? {} : { input }),
    });
    if (!ran.ok) return fromError(ran.error);
    const outcome = { ...ran.value, vault: vault.id, name: text(request.params, 'name') ?? '', trace };
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
    if (subject === undefined) return invalid('A subject is needed (--subject).');
    const key = text(request.params, 'key');
    const sent = await sendNotification(deps, { to, subject, body: text(request.params, 'body') ?? '', trace: request.caller.trace ?? newTraceId(context.ids), ...(key === undefined ? {} : { key }) });
    return sent.ok ? succeeded(`${sent.value.outcome} ${sent.value.messageId}`, sent.value) : fromError(sent.error);
  },
};

/**
 * The run's commits in `vault`, newest first — found by their `Vault-Trace`
 * on the accepted main and every local branch — with the records their notes hold.
 */
async function traceCommits(context: OperationContext, vault: RegisteredVault, trace: string): Promise<RunCommit[]> {
  const accepted = readingFrom(context, vault);
  const branches = await listRefs(context.git, vault.path, 'refs/heads/');
  const revisions = [...(accepted.ok ? [accepted.value.sha] : []), ...(branches.ok ? branches.value.map((r) => r.ref) : [])];
  const found = await runCommits(context.git, vault.path, revisions, trace);
  return found.ok ? found.value : [];
}

export const traceOperation: Operation = {
  name: 'trace',
  summary: 'Show a trace: its compact record, and full detail while logs are kept',
  vault: 'many',
  surfaces: { cli: true, command: true, mcp: true },
  params: [{ name: 'id', kind: 'string', required: true, positional: true, description: 'The trace ID' }],
  async run(context, request) {
    const id = text(request.params, 'id') ?? '';
    if (!isTraceId(id)) return invalid(`"${id}" is not a trace ID.`);
    // Each commit's record is the run's as of that commit, so the newest readable one says the most.
    const records: CompactTrace[] = [];
    const commits: { vault: string; commit: string; unreadable?: readonly number[] }[] = [];
    for (const vault of request.vaults) {
      const found = await traceCommits(context, vault, id);
      const latest = found.flatMap((c) => ('records' in c ? c.records : [])).at(0);
      if (latest !== undefined) records.push(latest);
      commits.push(...found.map((c) => ({ vault: vault.id, commit: c.commit, ...('unreadable' in c ? { unreadable: c.unreadable } : {}) })));
    }
    // Full logs are the machine's; through MCP they would show every vault's detail, so only local surfaces read them.
    const logs = request.caller.surface === 'mcp' ? [] : readFullLog(context.installation.paths.logs, id);
    if (commits.length === 0 && logs.length === 0) return fromError({ reason: 'not-found', path: `trace ${id}` });
    const short = (sha: string): string => sha.slice(0, 12);
    const lines = records.flatMap((r) => [
      `${r.vault}: ${r.trigger.event}${r.trigger.document === undefined ? '' : ` ${r.trigger.document}`}; path ${[...r.path, r.trace].join(' → ')}`,
      ...r.sessions.map((s) => `  session ${s.actor}: ${s.outcome}${s.reason === undefined ? '' : ` (${s.reason})`}, ${s.tokens} tokens`),
      ...r.documents.map((d) => `  produced ${d}`),
      ...r.scripts.map((s) => `  script ${s.name}: exit ${s.exitCode ?? 'none'}`),
      ...r.judgements.map((j) => `  judgement ${j.name}: ${j.result}`),
      `  commits: ${commits.filter((c) => c.vault === r.vault).map((c) => short(c.commit)).join(', ')}`,
    ]);
    lines.push(...commits.filter((c) => c.unreadable !== undefined).map((c) => `${c.vault}: the trace note on ${short(c.commit)} cannot be read (line ${c.unreadable?.join(', ')}).`));
    lines.push(...[...new Set(commits.map((c) => c.vault))].filter((v) => !records.some((r) => r.vault === v)).map((v) => `${v}: commits without a readable record: ${commits.filter((c) => c.vault === v).map((c) => short(c.commit)).join(', ')}`));
    if (logs.length > 0) lines.push(`Full logs: ${logs.map((l) => `${l.day}/${l.name}`).join(', ')}`);
    return succeeded(lines.join('\n'), { records, commits, logs });
  },
};
