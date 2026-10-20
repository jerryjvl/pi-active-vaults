// Proposal operations: status, review, accept (and adopt), sync, propose,
// commit and write. Owner acts — review, accept, adopt — are the caller's
// person's: the installation's person on the CLI, a profile's owner on MCP;
// writes are made as the caller's actor, never while another session holds
// it.

import { writeFileSync } from 'node:fs';
import {
  accept, adopt, adoptionDelta, commitAsActor, ensureActorWorktree, heldByAnother, worktreeFile, listActorHolds, readProposal, review, syncActorBranch,
  type AdoptionDelta, type Review,
} from '../../actors/index.ts';
import { backupVault } from '../../backup/index.ts';
import { deriveEvents } from '../../events/index.ts';
import { lostMergeReport, lostMerges, proposeToForge, syncWithForge, type MergeArrangement } from '../../forge/index.ts';
import { diffText } from '../../git/index.ts';
import { requireNoUnacceptedChange } from '../../integrity/index.ts';
import { undeliveredNotifications } from '../../notify/index.ts';
import { evaluateMerge, type MergeEvaluation } from '../../policy/index.ts';
import { listSpawns, vaultJobs, type SpawnEntry } from '../../queue/index.ts';
import { writersOf, type RegisteredVault } from '../../registry/index.ts';
import { newTraceId, recordRun } from '../../traces/index.ts';
import { packageIdentity, type OperationContext } from '../context.ts';
import { vaultRelative } from '../locate.ts';
import { fromError, invalid, refused, succeeded } from '../messages.ts';
import type { Operation } from '../types.ts';
import { jobsWithoutModel, unavailableText } from '../models.ts';
import { requestSpawns, spawnLines } from '../spawning.ts';
import { commitContext, flag, forgeDeps, identityOf, judgeForProposal, ownWorktree, personOf, readingFrom, text, texts, theVault, writerOf } from './common.ts';

const ACTOR_PARAM = { name: 'actor', kind: 'string', positional: true, description: 'The actor whose proposal it is' } as const;

/** The policy's state in a word: an owner's approval, which accepting gives, is not shown as a failure. */
function policySummary({ verdict }: MergeEvaluation): string {
  if (verdict.satisfied) return 'satisfied';
  return verdict.requirements.every((r) => r.met || r.requirement === 'owner') ? 'met once an owner accepts it' : 'not satisfied';
}

function evaluationLines(evaluation: MergeEvaluation): string[] {
  return [
    ...evaluation.checks.map((c) => `  check ${c.name}: ${c.status}`),
    ...evaluation.control.map((c) => `  control change: ${c.path} (${c.reason})`),
    ...evaluation.verdict.requirements.map((r) => `  ${r.met ? 'met' : 'unmet'} ${r.requirement}${r.met ? '' : `: ${r.reasons.join('; ')}`}`),
    `  merge policy ${policySummary(evaluation)}`,
  ];
}

export const statusOperation: Operation = {
  name: 'status',
  summary: 'Pending proposals, their checks and policy, queued work, holds and undelivered notifications',
  vault: 'many',
  surfaces: { cli: true, command: true, mcp: true },
  params: [],
  async run(context, request) {
    const vaults = [];
    const lines: string[] = [];
    const holds = await listActorHolds(context.state, context.alive);
    for (const vault of request.vaults) {
      const accepted = readingFrom(context, vault);
      lines.push(`${vault.id}: ${accepted.ok ? `accepted main ${accepted.value.sha}` : 'nothing accepted yet'}`);
      const proposals = [];
      const identity = await identityOf(context, vault);
      if (accepted.ok && identity.ok) {
        for (const actor of writersOf(identity.value)) {
          const proposal = await readProposal(context.git, vault.path, accepted.value, actor);
          if (!proposal.ok) continue;
          const { base, head, tainted, commits } = proposal.value;
          const evaluation = await evaluateMerge(context.git, vault.path, { accepted: accepted.value, base, head, tainted, reads: context.reads });
          proposals.push({ actor, head, commits: commits.length, tainted, evaluation: evaluation.ok ? evaluation.value : undefined });
          lines.push(`  proposal from ${actor}: ${commits.length} commit(s), head ${head}${tainted ? ', tainted' : ''}`);
          if (evaluation.ok) lines.push(...evaluationLines(evaluation.value).map((l) => `  ${l}`));
        }
      }
      const work = listSpawns(context.state, { vault: vault.id, states: ['queued', 'running'] });
      for (const spawn of work) lines.push(`  ${spawn.state}: ${spawn.document} (trace ${spawn.trace})`);
      const jobs = accepted.ok ? await vaultJobs(context.git, vault.path, accepted.value, context.reads) : undefined;
      const unrunnable = jobs?.ok === true ? jobsWithoutModel(context.installation.config, vault.id, jobs.value).map(({ job, why }) => ({ document: job.path, why })) : [];
      for (const { document, why } of unrunnable) lines.push(`  cannot run: ${document} (no agent model it may use: ${unavailableText(why)})`);
      const worktree = request.caller.surface === 'mcp' ? undefined : ownWorktree(context, vault);
      if (worktree !== undefined) lines.push(`  your worktree: ${worktree}`);
      const held = holds.filter((h) => h.vault === vault.id);
      for (const hold of held) lines.push(`  ${hold.actor} held by session ${hold.holder.session} (process ${hold.holder.process.pid}${hold.standing === 'cannot-tell' ? ', cannot tell whether it still runs' : ''})`);
      const lost = await lostMerges(context.git, context.state, vault);
      for (const merge of lost) lines.push(`  ${lostMergeReport(merge, vault)}`);
      vaults.push({ vault: vault.id, accepted: accepted.ok ? accepted.value.sha : null, ...(worktree === undefined ? {} : { worktree }), proposals, work, unrunnable, holds: held, lostMerges: lost });
    }
    // The outbox is the whole installation's, so a remote client — permitted for some vaults — does not see it.
    const undelivered = request.caller.surface === 'mcp' ? [] : undeliveredNotifications(context.state);
    if (undelivered.length > 0) lines.push(`Undelivered notifications: ${undelivered.map((n) => `${n.alias} "${n.subject}" (${n.state})`).join(', ')}`);
    return succeeded(lines.join('\n') || 'No vaults.', { vaults, undelivered });
  },
};

function reviewText(shown: Review, diff: string): string {
  const { proposal, evaluation, record } = shown;
  return [
    `Proposal from ${proposal.actor}: ${proposal.commits.length} commit(s) on ${proposal.branch}, head ${proposal.head}${proposal.tainted ? ' (tainted)' : ''}`,
    ...proposal.commits.map((c) => `  ${c.sha.slice(0, 12)} ${c.subject}`),
    'Changes:',
    ...evaluation.changes.map((c) => `  ${c.change} ${c.path}${c.oldPath === undefined ? '' : ` (from ${c.oldPath})`}`),
    ...evaluationLines(evaluation),
    '',
    diff.trimEnd(),
    '',
    `Recorded as ${record.reviewer}'s review of ${record.sha}.`,
  ].join('\n');
}

export const reviewOperation: Operation = {
  name: 'review',
  summary: 'Review an actor\'s proposal and record the commit reviewed',
  vault: 'one',
  surfaces: { cli: true, command: true, mcp: true },
  params: [{ ...ACTOR_PARAM, required: true }],
  async run(context, request) {
    const vault = theVault(request);
    const person = personOf(request.caller);
    if (!person.ok) return fromError(person.error);
    const actor = text(request.params, 'actor') ?? '';
    // Judged first, so the review shows the verdicts for exactly the content it records.
    const judged = await judgeForProposal(context, vault, actor, person.value);
    const reviewed = await review({ git: context.git, store: context.state, clock: context.clock, reads: context.reads }, vault, actor, person.value);
    if (!reviewed.ok) return fromError(reviewed.error);
    const diff = await diffText(context.git, vault.path, reviewed.value.proposal.base, reviewed.value.proposal.head);
    return succeeded([...judged, reviewText(reviewed.value, diff.ok ? diff.value : '')].join('\n'), reviewed.value);
  },
};

function deltaText(delta: AdoptionDelta): string {
  const { concerns } = delta;
  return [
    `Adopting ${delta.to} as the accepted main${delta.from === undefined ? ' (nothing accepted yet)' : `, from ${delta.from.sha}`}${delta.rewritten ? ' — HISTORY WAS REWRITTEN' : ''}`,
    ...(concerns.checks.length + concerns.control.length === 0 ? [] : ['Concerns, to acknowledge first:']),
    ...concerns.checks.map((c) => `  check ${c.name}: ${c.status}`),
    ...concerns.control.map((c) => `  control change: ${c.path} (${c.reason})`),
    'Commits:',
    ...delta.commits.map((c) => `  ${c.sha.slice(0, 12)} ${c.subject}`),
    '',
    delta.diff.trimEnd(),
  ].join('\n');
}

export const acceptOperation: Operation = {
  name: 'accept',
  summary: 'Accept the proposal you last reviewed if the merge policy is satisfied, or adopt main\'s tip',
  vault: 'one',
  surfaces: { cli: true, command: true, mcp: true },
  params: [
    ACTOR_PARAM,
    { name: 'adopt', kind: 'string', description: 'Adopt this commit, main\'s tip, as the accepted main instead' },
    { name: 'acknowledge', kind: 'string', description: 'The acknowledgement the delta showed for its concerns' },
    // Confirming is the person's: never offered where a model could give it (Pi tools, MCP).
    { name: 'yes', kind: 'boolean', short: 'y', surfaces: ['cli', 'command'], description: 'Confirm adopting the delta shown' },
  ],
  async run(context, request) {
    const vault = theVault(request);
    const person = personOf(request.caller);
    if (!person.ok) return fromError(person.error);
    const sha = text(request.params, 'adopt');
    if (sha !== undefined) {
      const delta = await adoptionDelta(context.git, context.state, vault, sha);
      if (!delta.ok) return fromError(delta.error);
      if (!flag(request.params, 'yes')) {
        const { acknowledgement, to } = delta.value;
        const shown = deltaText(delta.value);
        const ack = acknowledgement === undefined ? '' : ` --acknowledge ${acknowledgement}`;
        return {
          ...refused(`${shown}\n\nNot adopted yet. To adopt it: vault accept ${vault.id} --adopt ${to}${ack} --yes`, { delta: delta.value }),
          confirm: {
            shown,
            question: `Adopt ${to} as the accepted main${acknowledgement === undefined ? '' : ', acknowledging the concerns above'}?`,
            params: { yes: true, ...(acknowledgement === undefined ? {} : { acknowledge: acknowledgement }) },
          },
        };
      }
      const adopted = await adopt(context.git, context.state, vault, {
        sha: delta.value.to, approver: person.value, clock: context.clock, acknowledged: text(request.params, 'acknowledge'),
      });
      return adopted.ok ? succeeded(`Adopted ${adopted.value.sha} as vault "${vault.id}"'s accepted main.`, adopted.value) : fromError(adopted.error);
    }
    const actor = text(request.params, 'actor');
    if (actor === undefined) return invalid('Name the actor whose proposal to accept, or --adopt <sha>.');
    const accepted = await accept({ git: context.git, store: context.state, clock: context.clock, reads: context.reads }, vault, actor, {
      approver: person.value,
      identity: packageIdentity(context.installation, person.value),
      ...(request.caller.via === undefined ? {} : { via: request.caller.via }),
    });
    if (!accepted.ok) return fromError(accepted.error);
    return succeeded(`Accepted ${actor}'s proposal: vault "${vault.id}"'s accepted main is now ${accepted.value.accepted.sha}.`, accepted.value);
  },
};

export const syncOperation: Operation = {
  name: 'sync',
  summary: 'Bring actor branches up to date with the accepted main; in forge mode, fetch first; a local vault with a remote is backed up',
  vault: 'one',
  surfaces: { cli: true, command: false, mcp: false },
  params: [{ ...ACTOR_PARAM, description: 'Only this actor\'s branch' }],
  async run(context, request) {
    const vault = theVault(request);
    const identity = await identityOf(context, vault);
    if (!identity.ok) return fromError(identity.error);
    const lines: string[] = [];
    if (identity.value.review === 'forge') {
      const synced = await syncWithForge(forgeDeps(context, request.caller.person ?? 'vault'), vault);
      if (!synced.ok) return fromError(synced.error);
      lines.push(`Fetched the forge's main: the accepted main is ${synced.value.accepted.sha}${synced.value.mainUpdated ? '; main moved forward' : ''}.`);
    }
    const accepted = await requireNoUnacceptedChange(context.git, context.state, vault);
    if (!accepted.ok) return fromError(accepted.error);
    const given = text(request.params, 'actor');
    const committing = await commitContext(context, request.caller);
    const outcomes = [];
    for (const actor of given === undefined ? writersOf(identity.value) : [given]) {
      const synced = await syncActorBranch(committing, vault, accepted.value, actor, {
        origin: { trace: newTraceId(context.ids), actor }, date: context.clock.now(), identity: packageIdentity(context.installation, actor),
        ...(request.caller.holder === undefined ? {} : { holder: request.caller.holder }),
      });
      if (!synced.ok) return fromError(synced.error, { outcomes });
      outcomes.push({ actor, ...synced.value });
      if (synced.value.outcome !== 'no-branch') lines.push(`${actor}: ${synced.value.outcome}${synced.value.head === undefined ? '' : ` at ${synced.value.head}`}`);
    }
    if (identity.value.review === 'local' && vault.remote !== undefined) lines.push(await backupLine(context, { ...vault, remote: vault.remote }));
    return succeeded(lines.join('\n') || 'No actor branches to sync.', { outcomes });
  },
};

/** A local vault's backup, pushed now: what happened, or what to do. */
async function backupLine(context: OperationContext, vault: RegisteredVault & { remote: string }): Promise<string> {
  const done = await backupVault(context.git, vault);
  if (done.ok) return done.value.outcome === 'pushed' ? `Backed up to "${vault.remote}" (${done.value.refs} refs).` : `Backup at "${vault.remote}" is up to date.`;
  if (done.error.reason === 'missing-remote') return done.error.notes;
  return `Not backed up to "${vault.remote}": ${done.error.reason === 'push-refused' ? done.error.detail : done.error.reason}`;
}

export const proposeOperation: Operation = {
  name: 'propose',
  summary: 'In forge mode: push an actor\'s branch and open or update its pull request',
  vault: 'one',
  surfaces: { cli: true, command: false, mcp: true },
  params: [{ ...ACTOR_PARAM, required: true }],
  async run(context, request) {
    const vault = theVault(request);
    const actor = text(request.params, 'actor') ?? '';
    const judged = await judgeForProposal(context, vault, actor, request.caller.person ?? actor);
    const proposed = await proposeToForge(forgeDeps(context, request.caller.person ?? actor), vault, actor);
    if (!proposed.ok) return fromError(proposed.error);
    const { pull, opened, policy, merge } = proposed.value;
    return succeeded([
      ...judged,
      `${opened ? 'Opened' : 'Updated'} pull request #${pull.number} (${pull.url}); vault/policy: ${policy.state}.`,
      mergeText(merge),
    ].join('\n'), proposed.value);
  },
};

export const commitOperation: Operation = {
  name: 'commit',
  summary: 'Commit the actor\'s worktree, if every check passes, with the package\'s trailers',
  vault: 'one',
  surfaces: { cli: true, command: false, mcp: true, tool: 'direct' },
  params: [
    { name: 'message', kind: 'string', required: true, short: 'm', description: 'The commit message' },
    { name: 'paths', kind: 'strings', positional: true, vaultPath: true, description: 'Only these paths, as <vault-id>:<path> (default: everything in the worktree)' },
    { name: 'actor', kind: 'string', surfaces: ['cli', 'mcp'], required: ['mcp'], description: 'The actor to commit as' },
  ],
  async run(context, request) {
    const vault = theVault(request);
    const { caller, params } = request;
    const actor = await writerOf(context, vault, caller, params);
    if (!actor.ok) return fromError(actor.error);
    const accepted = await requireNoUnacceptedChange(context.git, context.state, vault);
    if (!accepted.ok) return fromError(accepted.error);
    const worktree = await ensureActorWorktree(context.git, vault, accepted.value, actor.value, context.reads);
    if (!worktree.ok) return fromError(worktree.error);
    const stage = texts(params, 'paths');
    const identity = packageIdentity(context.installation, actor.value);
    const committed = await commitAsActor(await commitContext(context, caller), vault, worktree.value.path, {
      origin: {
        trace: caller.trace ?? newTraceId(context.ids), actor: actor.value,
        ...(caller.session === undefined ? {} : { session: caller.session }),
        ...(caller.tainted === true ? { tainted: true } : {}),
      },
      message: text(params, 'message') ?? '',
      date: context.clock.now(),
      identity,
      ...(stage.length === 0 ? {} : { stage }),
      ...(caller.holder === undefined ? {} : { holder: caller.holder }),
    });
    if (!committed.ok) return fromError(committed.error);
    const checks = committed.value.checks.map((c) => `  ${c.name}: ${c.result}`);
    // A session's commit carries its compact record as a note, naming what the run has produced so far (concepts.md "Trace").
    // The commit has landed by now: a record that cannot be written is said, never a reason to undo it.
    const traced = caller.traceOf === undefined ? undefined : await recordRun(context.git, vault.path, {
      since: accepted.value.sha, commit: committed.value.sha, record: caller.traceOf(vault.id), attribution: { identity, date: context.clock.now() },
    });
    const traceLines = traced === undefined || traced.ok ? [] : [`Its trace record could not be written (${traced.error.reason}).`];
    // Judgements are checks that call a model: they run once the blocking checks have passed and the commit has landed,
    // and one that cannot be made only leaves its requirement unmet (concepts.md "Judgement axes").
    const judged = await judgeForProposal(context, vault, actor.value, actor.value);
    const spawned = await spawnsOfCommit(context, vault, committed.value.sha, caller.trace);
    return succeeded([`Committed ${committed.value.sha} on actor/${actor.value}.`, ...checks, ...judged, ...traceLines, ...spawned.lines].join('\n'), { ...committed.value, spawns: spawned.entries });
  },
};

/**
 * What a commit's own `committed` event spawns, requested now: in the
 * committing session's tree when a session made it, else in a new one. The
 * daemon derives the same event from the actor branch later; its identity is
 * the commit, so it is still one spawn.
 */
async function spawnsOfCommit(context: OperationContext, vault: RegisteredVault, sha: string, parent: string | undefined): Promise<{ lines: string[]; entries: SpawnEntry[] }> {
  const events = await deriveEvents(context.git, vault.path, vault.id, { kind: 'committed', from: `${sha}^`, to: sha });
  if (!events.ok) return { lines: [`Its events could not be read (${events.error.reason}); nothing was spawned.`], entries: [] };
  const entries: SpawnEntry[] = [];
  const lines: string[] = [];
  for (const event of events.value) {
    const requested = await requestSpawns(context, { event }, parent === undefined ? {} : { parent });
    if (!requested.ok) return { lines: [...lines, `Its spawns could not be matched (${requested.error.reason}).`], entries };
    entries.push(...requested.value.entries);
    lines.push(...spawnLines(requested.value.entries, requested.value.matched));
  }
  return { lines, entries };
}

export const writeOperation: Operation = {
  name: 'write',
  summary: 'Write a document in the actor\'s worktree',
  vault: 'one',
  surfaces: { cli: false, command: false, mcp: true },
  params: [
    { name: 'path', kind: 'string', required: true, vaultPath: true, description: 'The document, as <vault-id>:<path>' },
    { name: 'content', kind: 'string', required: true, description: 'Its whole new content' },
    { name: 'actor', kind: 'string', surfaces: ['mcp'], required: ['mcp'], description: 'The actor to write as: one of the vault\'s actors' },
  ],
  async run(context, request) {
    const vault = theVault(request);
    const actor = await writerOf(context, vault, request.caller, request.params);
    if (!actor.ok) return fromError(actor.error);
    const hold = await heldByAnother(context.state, context.alive, vault.id, actor.value, request.caller.holder);
    if (hold !== undefined) return fromError({ reason: 'actor-busy', hold });
    const accepted = readingFrom(context, vault);
    if (!accepted.ok) return fromError(accepted.error);
    const worktree = await ensureActorWorktree(context.git, vault, accepted.value, actor.value, context.reads);
    if (!worktree.ok) return fromError(worktree.error);
    const path = text(request.params, 'path') ?? '';
    const target = worktreeFile(worktree.value.path, path);
    if (target === undefined) return fromError({ reason: 'outside-worktree', path });
    const content = text(request.params, 'content') ?? '';
    writeFileSync(target, content);
    return succeeded(`Wrote ${vault.id}:${vaultRelative(path) ?? path} in actor/${actor.value}'s worktree; commit it to propose it.`, { vault: vault.id, path: vaultRelative(path), actor: actor.value, bytes: Buffer.byteLength(content) });
  },
};


/** What happens after approval: the forge merges it, or the owner must — and why. */
export function mergeText(merge: MergeArrangement): string {
  if (merge.by === 'forge') return merge.outcome === 'merged' ? 'It was already approved and passing: the forge merged it.' : 'The forge merges it once it is approved and vault/policy passes.';
  switch (merge.why) {
    case 'unsupported':
      return 'Merge it by hand once approved: this forge (or its entry, auto-merge: false) does not merge it itself.';
    case 'not-allowed':
      return 'Merge it by hand once approved: the forge refused to schedule the merge, because this account may not merge. Add it to the branch protection\'s merge allowlist (security-setup.md).';
    case 'failed':
      return `Merge it by hand once approved: asking the forge to merge it failed (${merge.detail ?? 'unknown'}); the daemon asks again.`;
  }
}
