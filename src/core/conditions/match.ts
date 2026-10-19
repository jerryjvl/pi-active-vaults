// Matching events against conditions.
//
// Conditions never name other vaults (principle 12). An event from another
// vault reaches a document only when the installation subscribes the
// document's vault to the event's vault; even then a path filter never matches
// it, because a condition's paths are paths in its own vault, and a label
// matches only where the installation declares the two vaults' labels
// equivalent. Actors, like paths, are names in the condition's own vault, so
// an actor filter never matches another vault's event. Session-wide events
// (start, tool) carry no vault: the caller offers the documents of the vaults
// the session uses. A `model` filter names one of the installation's models
// and is matched against the model the session actually runs on.

import type { InstallationConfig } from '../config/index.ts';
import type { Sha } from '../git/index.ts';
import { canonicalJson } from '../result/index.ts';
import { matchesGlob } from './globs.ts';
import type { ChangeKind, Condition } from './parse.ts';

export interface ChangedDocument {
  readonly path: string;
  readonly change: ChangeKind;
  /** For a rename, where the document was before. */
  readonly oldPath?: string;
  /** The labels the document carries (before deletion, for a deleted one). */
  readonly labels: readonly string[];
  /** The commit that made the change — within a merge, the commit it brought that last changed the path. */
  readonly commit: Sha;
  /** That commit's `Vault-Actor`, when the package made it. */
  readonly actor?: string;
  /** That commit's `Vault-Trace`: the run whose tree the change continues. */
  readonly trace?: string;
}

export interface GitEvent {
  readonly kind: 'committed' | 'merged';
  readonly vault: string;
  readonly commit: Sha;
  readonly changes: readonly ChangedDocument[];
  /** From the commit's trailers, when the package made it. */
  readonly trace?: string;
  readonly session?: string;
  /**
   * As a spawn answers it: the run whose session tree this part of the event
   * continues — the `Vault-Trace` of the changes it holds (concepts.md
   * "Session tree"); absent for the part no run made.
   */
  readonly tree?: string;
}

export type VaultEvent =
  | GitEvent
  /** Session events carry the Pi model (`provider/id`) the session runs on, when Pi says. */
  | { readonly kind: 'session.start'; readonly model?: string }
  | { readonly kind: 'session.tool'; readonly tool: string; readonly model?: string }
  | { readonly kind: 'session.path'; readonly vault: string; readonly path: string; readonly model?: string }
  /** `vault trigger`: `payload` is the JSON given with it, passed to the job as data. */
  | { readonly kind: 'external'; readonly vault: string; readonly name: string; readonly payload?: unknown };

export function isGitEvent(event: VaultEvent): event is GitEvent {
  return event.kind === 'committed' || event.kind === 'merged';
}

/** A document whose conditions are candidates for an event. */
export interface Candidate {
  readonly vault: string;
  readonly document: string;
  readonly conditions: readonly Condition[];
}

/** What the installation declares about how vaults relate and which models it has (concepts.md "Installation", "Models"). */
export interface MatchContext {
  readonly subscriptions: readonly { readonly from: string; readonly to: string }[];
  /** Groups of `<vault>:<label>` names that mean the same. */
  readonly equivalentLabels: readonly (readonly string[])[];
  /** The `agent` models by configured name, each as Pi names it (`provider/id`): what a `model` filter's name stands for. */
  readonly agentModels: Readonly<Record<string, string>>;
}

/** The matching context an installation's config declares. */
export function matchContextOf(config: Pick<InstallationConfig, 'subscriptions' | 'labels' | 'models'>): MatchContext {
  return {
    subscriptions: config.subscriptions,
    equivalentLabels: config.labels.equivalent,
    agentModels: Object.fromEntries(Object.entries(config.models).flatMap(([name, entry]) => (entry.role === 'agent' ? [[name, entry.model]] : []))),
  };
}

/**
 * Whether a session event's model satisfies a condition's `model` filter: the
 * filter names a configured agent model, and matches when that name stands for
 * the Pi model the session actually uses (the reverse lookup of that model's
 * names). A name that is not configured, or a session that does not say what
 * it runs on, matches nothing.
 */
function modelMatches(wanted: string | undefined, used: string | undefined, context: MatchContext): boolean {
  if (wanted === undefined) return true;
  return used !== undefined && Object.hasOwn(context.agentModels, wanted) && context.agentModels[wanted] === used;
}

export interface Match {
  readonly vault: string;
  readonly document: string;
  /** The condition's position in the document's conditions. */
  readonly index: number;
  readonly condition: Condition;
}

type Reach = 'own' | 'subscribed';

function reach(event: VaultEvent, vault: string, context: MatchContext): Reach | undefined {
  if (!('vault' in event) || event.vault === vault) return 'own';
  return context.subscriptions.some((s) => s.from === event.vault && s.to === vault) ? 'subscribed' : undefined;
}

function sameLabel(a: string, b: string, context: MatchContext): boolean {
  return a === b || context.equivalentLabels.some((group) => group.includes(a) && group.includes(b));
}

function anyPath(paths: readonly string[], change: ChangedDocument): boolean {
  return paths.some((p) => matchesGlob(change.path, p) || (change.oldPath !== undefined && matchesGlob(change.oldPath, p)));
}

function gitEventMatches(condition: Condition, event: GitEvent, vault: string, reached: Reach, context: MatchContext): boolean {
  const { paths, change, labels, actor } = condition;
  if (paths === undefined && change === undefined && labels === undefined && actor === undefined) return true;
  if ((paths !== undefined || actor !== undefined) && reached !== 'own') return false;
  return event.changes.some((changed) =>
    (paths === undefined || anyPath(paths, changed)) &&
    (change === undefined || change.includes(changed.change)) &&
    (actor === undefined || (changed.actor !== undefined && actor.includes(changed.actor))) &&
    (labels === undefined ||
      labels.some((wanted) => changed.labels.some((carried) => sameLabel(`${vault}:${wanted}`, `${event.vault}:${carried}`, context)))),
  );
}

function matches(condition: Condition, event: VaultEvent, vault: string, reached: Reach, context: MatchContext): boolean {
  if (condition.on !== event.kind) return false;
  switch (event.kind) {
    case 'committed':
    case 'merged':
      return gitEventMatches(condition, event, vault, reached, context);
    case 'session.start':
      return modelMatches(condition.model, event.model, context);
    case 'session.tool':
      return modelMatches(condition.model, event.model, context) &&
        (condition.tools === undefined || condition.tools.includes(event.tool));
    case 'session.path':
      return modelMatches(condition.model, event.model, context) &&
        (condition.paths === undefined || (reached === 'own' && condition.paths.some((p) => matchesGlob(event.path, p))));
    case 'external':
      return condition.name === event.name;
  }
}

/**
 * The event as the structured data a spawned job, or a condition's script,
 * receives: canonical JSON, so the same event always gives the same text. Any
 * event a spawn answers — a timer's or a manual run's too — is rendered alike.
 */
export function eventJson(event: { readonly kind: string }): string {
  return canonicalJson(event);
}

const byPosition = (a: Match, b: Match): number =>
  a.vault < b.vault ? -1 : a.vault > b.vault ? 1 : a.document < b.document ? -1 : a.document > b.document ? 1 : a.index - b.index;

/** Every (document, condition) the event matches, in a stable order: vault, document, condition. */
export function matchConditions(event: VaultEvent, candidates: readonly Candidate[], context: MatchContext): Match[] {
  const found: Match[] = [];
  for (const { vault, document, conditions } of candidates) {
    const reached = reach(event, vault, context);
    if (reached === undefined) continue;
    conditions.forEach((condition, index) => {
      if (matches(condition, event, vault, reached, context)) found.push({ vault, document, index, condition });
    });
  }
  return found.sort(byPosition);
}
