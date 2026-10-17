// Matching events against conditions.
//
// Conditions never name other vaults (principle 12). An event from another
// vault reaches a document only when the installation subscribes the
// document's vault to the event's vault; even then a path filter never matches
// it, because a condition's paths are paths in its own vault, and a label
// matches only where the installation declares the two vaults' labels
// equivalent. Session-wide events (start, tool) carry no vault: the caller
// offers the documents of the vaults the session uses.

import type { Sha } from '../git/index.ts';
import { matchesGlob } from './globs.ts';
import type { ChangeKind, Condition } from './parse.ts';

export interface ChangedDocument {
  readonly path: string;
  readonly change: ChangeKind;
  /** For a rename, where the document was before. */
  readonly oldPath?: string;
  /** The labels the document carries (before deletion, for a deleted one). */
  readonly labels: readonly string[];
}

export interface GitEvent {
  readonly kind: 'committed' | 'merged';
  readonly vault: string;
  readonly commit: Sha;
  readonly changes: readonly ChangedDocument[];
  /** From the commit's trailers, when the package made it. */
  readonly trace?: string;
  readonly session?: string;
}

export type VaultEvent =
  | GitEvent
  | { readonly kind: 'session.start'; readonly model?: string }
  | { readonly kind: 'session.tool'; readonly tool: string; readonly model?: string }
  | { readonly kind: 'session.path'; readonly vault: string; readonly path: string; readonly model?: string }
  | { readonly kind: 'external'; readonly vault: string; readonly name: string };

/** A document whose conditions are candidates for an event. */
export interface Candidate {
  readonly vault: string;
  readonly document: string;
  readonly conditions: readonly Condition[];
}

/** What the installation declares about how vaults relate (concepts.md "Installation"). */
export interface MatchContext {
  readonly subscriptions: readonly { readonly from: string; readonly to: string }[];
  /** Groups of `<vault>:<label>` names that mean the same. */
  readonly equivalentLabels: readonly (readonly string[])[];
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
  const { paths, change, labels } = condition;
  if (paths === undefined && change === undefined && labels === undefined) return true;
  if (paths !== undefined && reached !== 'own') return false;
  return event.changes.some((changed) =>
    (paths === undefined || anyPath(paths, changed)) &&
    (change === undefined || change.includes(changed.change)) &&
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
      return condition.model === undefined || condition.model === event.model;
    case 'session.tool':
      return (condition.model === undefined || condition.model === event.model) &&
        (condition.tools === undefined || condition.tools.includes(event.tool));
    case 'session.path':
      return (condition.model === undefined || condition.model === event.model) &&
        (condition.paths === undefined || (reached === 'own' && condition.paths.some((p) => matchesGlob(event.path, p))));
    case 'external':
      return condition.name === event.name;
  }
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
