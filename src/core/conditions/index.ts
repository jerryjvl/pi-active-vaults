// Public surface of the conditions module: path globs, `applies-when`
// parsing, matching Git, session and external events against conditions, the
// event as structured data, and narrowing matches by their scripts.

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
  eventJson,
  isGitEvent,
  matchConditions,
  type Candidate,
  type ChangedDocument,
  type GitEvent,
  type Match,
  type MatchContext,
  type VaultEvent,
} from './match.ts';
export { documentConditions, type DocumentConditions } from './documents.ts';
export { narrowByScripts, type Narrowed, type ScriptFilterContext, type ScriptFilterOptions } from './script.ts';
