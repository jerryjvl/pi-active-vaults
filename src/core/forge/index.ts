// Public surface of the forge module: one adapter interface over Gitea,
// GitHub and GitLab, and forge mode built on it — proposing, publishing
// statuses with `vault/policy`, syncing, the only pushes the package makes,
// and whether merged proposals reached `main` with their commits.

export {
  POLICY_CONTEXT,
  UNPROTECTED,
  protectionProblems,
  type BranchProtection,
  type CommitStatus,
  type ForgeAdapter,
  type ForgeApproval,
  type ForgeError,
  type ForgeSettings,
  type MergeMethods,
  type ProtectionProblem,
  type PullRequest,
  type StatusState,
} from './adapter.ts';
export {
  checkMerges,
  lostMergeNotice,
  lostMergeReport,
  lostMerges,
  uncheckedMerges,
  type MergedProposal,
  type StandingMerge,
} from './merges.ts';
export { forgeSchema, type MergeResult } from './merged.ts';
export { forgeAdapter, forgeProject } from './project.ts';
export {
  proposeToForge,
  publishStatuses,
  pushToForge,
  remoteOf,
  syncWithForge,
  type ForgeDeps,
  type ForgeSyncError,
  type PolicyStatus,
} from './sync.ts';
