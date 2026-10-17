// Judging documents (core.md "Judgements"): a document's content, sent as
// state with the questions of its axes to the judgement model; each answer
// held against its axis's `pass-when`; each outcome recorded as an
// attestation about the content (its blob), naming the model and the axis's
// version.
//
// Invariants:
//  - a judgement is a check, so it composes like every script run: no
//    unaccepted change, then everything that decides — the axes, the vault's
//    purpose — from the accepted `main`; the commit judged supplies only the
//    content, so a proposal cannot loosen the axes it is judged by;
//  - content goes only to a model the installation's policy permits for the
//    vault, and is never shortened: content too large for the model is the
//    model's error, and a failed judgement;
//  - a judgement that cannot be made returns its reason and records nothing,
//    so the requirement stays unmet — a failure, never a pass;
//  - an axis already judged for this exact content, by this model under this
//    axis version, is not asked again: the attestation is the record;
//  - content is data: it is sent only as state, never as instructions.

import { readAttestations, latestAttestation, recordAttestation, type AttestationError } from '../attestations/index.ts';
import { readProposal, type ProposalError } from '../actors/index.ts';
import type { Clock } from '../clock/index.ts';
import type { InstallationConfig } from '../config/index.ts';
import { contractReader, type ContractError } from '../contracts/index.ts';
import { documentTitle, labelsOf, parseDocument, utf8Text } from '../documents/index.ts';
import { TREE_MODES, listTree, readFileAt, type Attribution, type Git, type GitError, type Sha } from '../git/index.ts';
import { requireNoUnacceptedChange, type UnacceptedChangeError, type VaultLocation } from '../integrity/index.ts';
import { askSystemOne, modelFor, type ModelClient, type ModelError, type RoleUnavailable, type SystemOneQuestion } from '../models/index.ts';
import { axesVersion, evaluateMerge, type PolicyError } from '../policy/index.ts';
import { readVaultIdentity, type IdentityError } from '../registry/index.ts';
import { err, ok, type Issue, type Result } from '../result/index.ts';
import type { Queryable } from '../store/index.ts';
import { axisVerdict, parseAxes, type Axis } from './axes.ts';

export interface JudgementDeps {
  readonly git: Git;
  readonly store: Queryable;
  readonly config: Pick<InstallationConfig, 'models' | 'policy'>;
  readonly client: ModelClient;
  readonly clock: Clock;
  /** Who the attestations' notes commit is made as. */
  readonly attribution: Attribution;
}

export interface AxisJudgement {
  readonly name: string;
  readonly result: 'pass' | 'fail';
  readonly evidence: string;
  /** Taken from an earlier judgement of the same content, model and axis version. */
  readonly reused: boolean;
}

export interface Judgement {
  readonly path: string;
  /** The content judged: its blob SHA. */
  readonly subject: Sha;
  readonly model: string;
  /** Every axis passed. */
  readonly passed: boolean;
  readonly axes: readonly AxisJudgement[];
  /** What the request used; absent when nothing was asked or the model did not say. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export type JudgementError =
  | GitError
  | UnacceptedChangeError
  | ContractError
  | IdentityError
  | AttestationError
  | RoleUnavailable
  | ModelError
  | { readonly reason: 'no-axes'; readonly path: string }
  | { readonly reason: 'invalid-axes'; readonly issues: readonly Issue[] }
  | { readonly reason: 'not-text'; readonly path: string };

/** The blob and text of `path` in `commit`; a link or binary content cannot be judged. */
async function contentAt(git: Git, repo: string, commit: Sha, path: string): Promise<Result<{ blob: Sha; text: string }, JudgementError>> {
  const slash = path.lastIndexOf('/');
  const entries = await listTree(git, repo, commit, slash < 0 ? undefined : path.slice(0, slash));
  if (!entries.ok) return entries;
  const entry = entries.value.find((e) => e.path === path);
  if (entry === undefined) return err({ reason: 'not-found', path });
  if (entry.mode === TREE_MODES.symlink) return err({ reason: 'not-text', path });
  const bytes = await readFileAt(git, repo, commit, path);
  if (!bytes.ok) return bytes;
  const text = utf8Text(bytes.value);
  return text === undefined ? err({ reason: 'not-text', path }) : ok({ blob: entry.sha, text });
}

/** Judges the document at `path` in `commit` on every axis in effect for it on the accepted main. */
export async function judgeDocument(
  deps: JudgementDeps, request: { readonly vault: VaultLocation; readonly commit: Sha; readonly path: string },
): Promise<Result<Judgement, JudgementError>> {
  const { git, store } = deps;
  const { vault, commit, path } = request;
  const accepted = await requireNoUnacceptedChange(git, store, vault);
  if (!accepted.ok) return accepted;
  const effective = await contractReader(git, vault.path, accepted.value.sha).forFile(path);
  if (!effective.ok) return effective;
  const defined = effective.value.values['axes'];
  if (defined === undefined) return err({ reason: 'no-axes', path });
  const axes = parseAxes(defined);
  if (!axes.ok) return err({ reason: 'invalid-axes', issues: axes.error });
  if (axes.value.length === 0) return err({ reason: 'no-axes', path });

  const content = await contentAt(git, vault.path, commit, path);
  if (!content.ok) return content;
  const model = modelFor(deps.config, 'judgement', [vault.id]);
  if (!model.ok) return model;
  const by = model.value.endpoint.model;
  const earlier = await readAttestations(git, vault.path, content.value.blob);
  if (!earlier.ok) return earlier;

  const judged = new Map<string, AxisJudgement>();
  const toAsk: Axis[] = [];
  for (const axis of axes.value) {
    const latest = latestAttestation(earlier.value, 'judgement', axis.name);
    const current = latest !== undefined && latest.by === by && latest.version === axesVersion(axis.definition);
    if (current && (latest.result === 'pass' || latest.result === 'fail')) {
      judged.set(axis.name, { name: axis.name, result: latest.result, evidence: latest.evidence ?? '', reused: true });
    } else {
      toAsk.push(axis);
    }
  }

  let usage: Judgement['usage'];
  if (toAsk.length > 0) {
    const identity = await readVaultIdentity(git, vault.path, accepted.value.sha);
    if (!identity.ok) return identity;
    const parsed = parseDocument(content.value.text);
    const state = {
      vault: identity.value.purpose.summary,
      path,
      title: documentTitle(path, content.value.text),
      labels: parsed.ok ? labelsOf(parsed.value.frontmatter) : [],
      content: content.value.text,
    };
    const questions: Record<string, SystemOneQuestion> = Object.fromEntries(toAsk.map((axis) => [axis.name, axis.question]));
    const asked = await askSystemOne(deps.client, model.value, { state, questions });
    if (!asked.ok) return asked;
    usage = asked.value.usage;
    for (const axis of toAsk) {
      const answer = asked.value.answers[axis.name];
      if (answer === undefined) throw new Error('the System One client returned without an answer it checked for');
      const verdict = axisVerdict(axis, answer);
      const recorded = await recordAttestation(git, vault.path, {
        kind: 'judgement', name: axis.name, subject: content.value.blob, result: verdict.result, by,
        version: axesVersion(axis.definition), evidence: verdict.evidence, at: deps.clock.now().toISOString(),
      }, deps.attribution);
      if (!recorded.ok) return recorded;
      judged.set(axis.name, { name: axis.name, ...verdict, reused: false });
    }
  }

  const results = axes.value.flatMap((axis) => judged.get(axis.name) ?? []);
  return ok({
    path, subject: content.value.blob, model: by, passed: results.every((a) => a.result === 'pass'), axes: results,
    ...(usage === undefined ? {} : { usage }),
  });
}

/** Judges the documents an actor's proposal still needs judged by its merge policy, in path order; each outcome on its own. */
export async function judgeProposal(
  deps: JudgementDeps, request: { readonly vault: VaultLocation; readonly actor: string },
): Promise<Result<{ path: string; outcome: Result<Judgement, JudgementError> }[], JudgementError | ProposalError | PolicyError>> {
  const { git, store } = deps;
  const accepted = await requireNoUnacceptedChange(git, store, request.vault);
  if (!accepted.ok) return accepted;
  const proposal = await readProposal(git, request.vault.path, accepted.value, request.actor);
  if (!proposal.ok) return proposal;
  const evaluation = await evaluateMerge(git, request.vault.path, {
    accepted: accepted.value, base: proposal.value.base, head: proposal.value.head, tainted: proposal.value.tainted,
  });
  if (!evaluation.ok) return evaluation;
  // A deleted path's judgement already became `owner`, so every path left here has content.
  const paths = [...new Set(evaluation.value.verdict.requirements.filter((r) => r.requirement.startsWith('judgement:') && !r.met).flatMap((r) => r.paths))].sort();
  const outcomes = [];
  for (const path of paths) outcomes.push({ path, outcome: await judgeDocument(deps, { vault: request.vault, commit: proposal.value.head, path }) });
  return ok(outcomes);
}
