// Public surface of the conditions module: path globs, `applies-when`
// parsing, and matching Git, session and external events against conditions.

export { globIssue, matchesGlob } from './globs.ts';
export {
  CHANGE_KINDS,
  EVENT_KINDS,
  parseConditions,
  type ChangeKind,
  type Condition,
  type EventKind,
} from './parse.ts';
export {
  matchConditions,
  type Candidate,
  type ChangedDocument,
  type GitEvent,
  type Match,
  type MatchContext,
  type VaultEvent,
} from './match.ts';
