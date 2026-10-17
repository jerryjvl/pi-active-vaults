// Merge rules (concepts.md "Merge policy"): path globs and what a change to a
// matching path requires — `checks`, `owner`, `judgement:<name>` — plus extra
// requirements when the proposal is tainted. Parsing is strict: a misspelt
// requirement must be an error, not a rule that requires nothing.

import { globIssue } from '../conditions/index.ts';
import { DataReader, issuePath, type Issue, type Result } from '../result/index.ts';

export type JudgementRequirement = `judgement:${string}`;
export type Requirement = 'checks' | 'owner' | JudgementRequirement;

export interface MergeRule {
  readonly paths: readonly string[];
  readonly require: readonly Requirement[];
  readonly whenTainted: readonly Requirement[];
}

const REQUIREMENT = /^(?:checks|owner|judgement:[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const JUDGEMENT_PREFIX = 'judgement:';

export function isJudgement(requirement: Requirement): requirement is JudgementRequirement {
  return requirement.startsWith(JUDGEMENT_PREFIX);
}

export function judgementName(requirement: JudgementRequirement): string {
  return requirement.slice(JUDGEMENT_PREFIX.length);
}

function readRequirements(r: DataReader, value: unknown, path: string): Requirement[] {
  return r.list(value, path).flatMap((item, i) => {
    if (typeof item === 'string' && REQUIREMENT.test(item)) return [item as Requirement];
    r.add(`${path}[${i}]`, 'must be checks, owner or judgement:<name>');
    return [];
  });
}

export function parseMergeRules(value: unknown, path = 'merge'): Result<MergeRule[], Issue[]> {
  const r = new DataReader();
  const rules = r.list(value, path).map((item, i): MergeRule => {
    const where = `${path}[${i}]`;
    const rule = r.record(item, where, ['paths', 'require', 'when-tainted']);
    const pathsWhere = issuePath(where, 'paths');
    const globs = r.list(rule['paths'], pathsWhere);
    if (Array.isArray(rule['paths']) && globs.length === 0) r.add(pathsWhere, 'must not be empty');
    const paths = globs.map((glob, j) => {
      const text = r.string(glob, `${pathsWhere}[${j}]`);
      const issue = text === '' ? undefined : globIssue(text);
      if (issue !== undefined) r.add(`${pathsWhere}[${j}]`, issue);
      return text;
    });
    const require = readRequirements(r, rule['require'] ?? [], issuePath(where, 'require'));
    const whenTainted = readRequirements(r, rule['when-tainted'] ?? [], issuePath(where, 'when-tainted'));
    const asked = (key: string): number => (Array.isArray(rule[key]) ? (rule[key] as unknown[]).length : 0);
    if (asked('require') === 0 && asked('when-tainted') === 0) r.add(where, 'must require something, plainly or when tainted');
    return { paths, require, whenTainted };
  });
  return r.result(rules);
}
