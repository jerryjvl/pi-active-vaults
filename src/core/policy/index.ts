// Public surface of the policy module: merge rules, control changes, and
// evaluating what a proposal needs before it may reach `main`.

export {
  parseMergeRules,
  type JudgementRequirement,
  type MergeRule,
  type Requirement,
} from './rules.ts';
export { findControlChanges, type ControlChange } from './control.ts';
export {
  axesVersion,
  checkStatuses,
  evaluatePolicy,
  type CheckStatus,
  type PolicyChange,
  type PolicyInput,
  type PolicyVerdict,
  type RequirementVerdict,
} from './evaluate.ts';
export { evaluateMerge, type MergeEvaluation, type MergeRequest, type PolicyError } from './merge.ts';
