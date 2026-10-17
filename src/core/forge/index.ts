// Public surface of the forge module: one adapter interface over Gitea,
// GitHub and GitLab, and forge mode built on it — proposing, publishing
// statuses with `vault/policy`, syncing, and the only pushes the package makes.

export {
  POLICY_CONTEXT,
  UNPROTECTED,
  apiBase,
  protectionProblems,
  type BranchProtection,
  type CommitStatus,
  type ForgeAdapter,
  type ForgeApproval,
  type ForgeError,
  type ProtectionProblem,
  type PullRequest,
  type StatusState,
} from './adapter.ts';
export { forgeAdapter, forgeProject } from './project.ts';
export {
  proposeToForge,
  publishStatuses,
  pushToForge,
  syncWithForge,
  type ForgeDeps,
  type ForgeSyncError,
  type PolicyStatus,
} from './sync.ts';
