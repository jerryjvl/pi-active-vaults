// Forge mode (concepts.md "Actor", security.md): proposals go to the forge as
// pull requests, the forge merges under its branch protection, and the
// package learns of merges by fetching.
//
// Invariants:
//  - the package pushes only actor branches and attestation notes — each to
//    the same name — never `main`: `pushToForge` refuses any other refspec
//    before git runs;
//  - proposing is a propagating action: refused while `main` has an
//    unaccepted change, and only for a forge-mode vault;
//  - notes meet the forge's line by line before any are pushed, so no record
//    from either side is lost (and the push is a fast-forward);
//  - `vault/policy` is the vault's merge policy evaluated as on accept —
//    rules, owners and checks from the accepted `main`, attestations for the
//    exact commit — with owners' forge approvals of exactly that commit;
//    an approval of another commit, by a non-owner, or for no known commit
//    counts for nothing. It says `success` only when the policy is satisfied;
//  - syncing makes the forge's `main` the accepted `main` (the forge enforced
//    review there) and moves the local `main` only forward to it: local
//    commits the forge does not have are never discarded, and stay an
//    unaccepted change for the owner.
//
// The vault's forge remote is `origin`.

import { ATTESTATIONS_REF, mergeAttestations, type Attestation, type AttestationError } from '../attestations/index.ts';
import { actorBranch, readProposal, type Proposal, type ProposalError } from '../actors/index.ts';
import type { Clock } from '../clock/index.ts';
import type { ForgeEntry } from '../config/index.ts';
import {
  fastForward, fetchRefs, isAncestor, listWorktrees, pushRefs, remoteUrl, resolveRevision, updateRef,
  type Attribution, type Git, type GitError, type Sha,
} from '../git/index.ts';
import {
  MAIN_BRANCH, acceptedMain, mainTip, recordAccepted, requireNoUnacceptedChange,
  type AcceptedMain, type AcceptedReads, type UnacceptedChangeError, type VaultLocation,
} from '../integrity/index.ts';
import { evaluateMerge, type CheckStatus, type PolicyError } from '../policy/index.ts';
import { readVaultIdentity, type IdentityError } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { POLICY_CONTEXT, type CommitStatus, type ForgeAdapter, type ForgeDepsBase, type ForgeError, type PullRequest, type StatusState } from './adapter.ts';
import { forgeAdapter, forgeProject } from './project.ts';

export interface ForgeDeps extends ForgeDepsBase {
  readonly git: Git;
  readonly store: Store;
  readonly clock: Clock;
  /** Who notes merges are made as. */
  readonly attribution: Attribution;
  readonly forges: readonly ForgeEntry[];
  /** What has been read from accepted mains, kept while they stay accepted. */
  readonly reads?: AcceptedReads;
}

export type ForgeSyncError =
  | ForgeError
  | GitError
  | IdentityError
  | ProposalError
  | PolicyError
  | AttestationError
  | UnacceptedChangeError
  | { readonly reason: 'no-remote'; readonly remote: string }
  | { readonly reason: 'not-forge-mode' }
  | { readonly reason: 'not-pushable'; readonly refspec: string }
  | { readonly reason: 'accepted-moved'; readonly current: Sha | null };

const REMOTE = 'origin';
const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const FORGE_MAIN = `refs/remotes/${REMOTE}/${MAIN_BRANCH}`;
// The forge's notes are fetched beside ours, then merged into ours.
const FORGE_NOTES_PREFIX = 'refs/notes/vault-forge';
const FORGE_ATTESTATIONS = `${FORGE_NOTES_PREFIX}/attestations`;

/** Only actor branches and the attestation notes, each pushed to its own name, never forced. */
export async function pushToForge(git: Git, repo: string, refspecs: readonly string[]): Promise<Result<void, ForgeSyncError>> {
  for (const refspec of refspecs) {
    const [source, destination, ...rest] = refspec.split(':');
    const own = source === destination && rest.length === 0;
    if (!own || source === undefined || !(source.startsWith('refs/heads/actor/') || source === ATTESTATIONS_REF)) return err({ reason: 'not-pushable', refspec });
  }
  return pushRefs(git, repo, REMOTE, refspecs);
}

async function connect(deps: ForgeDeps, vault: VaultLocation): Promise<Result<ForgeAdapter, ForgeSyncError>> {
  const url = await remoteUrl(deps.git, vault.path, REMOTE);
  if (!url.ok) return url;
  if (url.value === undefined) return err({ reason: 'no-remote', remote: REMOTE });
  const found = forgeProject(deps.forges, url.value);
  return found.ok ? ok(forgeAdapter(found.value.entry, found.value.project, deps)) : found;
}

async function requireForgeMode(git: Git, repo: string, sha: Sha): Promise<Result<readonly string[], ForgeSyncError>> {
  const identity = await readVaultIdentity(git, repo, sha);
  if (!identity.ok) return identity;
  return identity.value.review === 'forge' ? ok(identity.value.owners) : err({ reason: 'not-forge-mode' });
}

/** Fetches the forge's attestation notes and merges them into ours, line by line. */
async function meetNotes(deps: ForgeDeps, vault: VaultLocation, also: readonly string[] = []): Promise<Result<void, ForgeSyncError>> {
  const fetched = await fetchRefs(deps.git, vault.path, REMOTE, [...also, `+refs/notes/vault/*:${FORGE_NOTES_PREFIX}/*`]);
  if (!fetched.ok) return fetched;
  const theirs = await resolveRevision(deps.git, vault.path, FORGE_ATTESTATIONS);
  if (!theirs.ok) return theirs.error.reason === 'unknown-revision' ? ok(undefined) : theirs;
  return mergeAttestations(deps.git, vault.path, FORGE_ATTESTATIONS, deps.attribution);
}

export interface PolicyStatus {
  readonly state: StatusState;
  readonly description: string;
}

function checkState(check: CheckStatus): StatusState {
  return check.status === 'pass' ? 'success' : check.status === 'missing' || check.status === 'stale' ? 'pending' : check.status === 'unusable' ? 'error' : 'failure';
}

/** Publishes each check's result and `vault/policy` on the proposal's head. */
async function publish(
  deps: ForgeDeps, adapter: ForgeAdapter, vault: VaultLocation, accepted: AcceptedMain, owners: readonly string[], proposal: Proposal, pull: PullRequest | undefined,
): Promise<Result<{ policy: PolicyStatus; checks: CommitStatus[] }, ForgeSyncError>> {
  const given = pull === undefined ? ok([]) : await adapter.approvals(pull);
  if (!given.ok) return given;
  const approvals: Attestation[] = given.value
    .filter((a) => a.commit === proposal.head && owners.includes(a.user))
    .map((a) => ({ kind: 'approval', name: a.user, subject: proposal.head, result: 'pass', by: `${a.user} via forge`, at: deps.clock.now().toISOString() }));
  const evaluation = await evaluateMerge(deps.git, vault.path, {
    accepted, base: proposal.base, head: proposal.head, tainted: proposal.tainted, approvals,
    ...(deps.reads === undefined ? {} : { reads: deps.reads }),
  });
  if (!evaluation.ok) return evaluation;
  const { verdict } = evaluation.value;
  const unmet = verdict.requirements.filter((r) => !r.met);
  const policy: PolicyStatus = verdict.satisfied
    ? { state: 'success', description: 'The merge policy is satisfied' }
    : { state: unmet.some((r) => r.failed) ? 'failure' : 'pending', description: `Unmet: ${unmet.map((r) => r.requirement).join(', ')}` };
  const checks: CommitStatus[] = evaluation.value.checks.map((check) => ({ context: `vault/check/${check.name}`, state: checkState(check), description: check.status }));
  for (const status of [...checks, { context: POLICY_CONTEXT, ...policy }]) {
    const set = await adapter.setStatus(proposal.head, status);
    if (!set.ok) return set;
  }
  return ok({ policy, checks });
}

interface Prepared {
  readonly accepted: AcceptedMain;
  readonly owners: readonly string[];
  readonly proposal: Proposal;
  readonly adapter: ForgeAdapter;
}

async function prepare(deps: ForgeDeps, vault: VaultLocation, actor: string): Promise<Result<Prepared, ForgeSyncError>> {
  const accepted = await requireNoUnacceptedChange(deps.git, deps.store, vault);
  if (!accepted.ok) return accepted;
  const owners = await requireForgeMode(deps.git, vault.path, accepted.value.sha);
  if (!owners.ok) return owners;
  const proposal = await readProposal(deps.git, vault.path, accepted.value, actor);
  if (!proposal.ok) return proposal;
  const adapter = await connect(deps, vault);
  return adapter.ok ? ok({ accepted: accepted.value, owners: owners.value, proposal: proposal.value, adapter: adapter.value }) : adapter;
}

function describe(proposal: Proposal): { title: string; body: string } {
  return {
    title: `Proposal from ${proposal.actor}`,
    body: [`Commits on ${proposal.branch}:`, '', ...proposal.commits.map((c) => `- ${c.subject}`), '', 'Opened by pi-active-vaults.'].join('\n'),
  };
}

/** Pushes an actor's proposal and the notes, opens or updates its pull request, and publishes its statuses. */
export async function proposeToForge(
  deps: ForgeDeps, vault: VaultLocation, actor: string,
): Promise<Result<{ pull: PullRequest; opened: boolean; policy: PolicyStatus }, ForgeSyncError>> {
  const prepared = await prepare(deps, vault, actor);
  if (!prepared.ok) return prepared;
  const { proposal, adapter } = prepared.value;
  const met = await meetNotes(deps, vault);
  if (!met.ok) return met;
  const branchRef = `refs/heads/${proposal.branch}`;
  const notes = await resolveRevision(deps.git, vault.path, ATTESTATIONS_REF);
  if (!notes.ok && notes.error.reason !== 'unknown-revision') return notes;
  const pushed = await pushToForge(deps.git, vault.path, [`${branchRef}:${branchRef}`, ...(notes.ok ? [`${ATTESTATIONS_REF}:${ATTESTATIONS_REF}`] : [])]);
  if (!pushed.ok) return pushed;

  const found = await adapter.findPullRequest(actorBranch(actor), MAIN_BRANCH);
  if (!found.ok) return found;
  const text = describe(proposal);
  let pull: PullRequest;
  if (found.value === undefined) {
    const opened = await adapter.openPullRequest({ head: actorBranch(actor), base: MAIN_BRANCH, ...text });
    if (!opened.ok) return opened;
    pull = opened.value;
  } else {
    const updated = await adapter.updatePullRequest(found.value.number, text);
    if (!updated.ok) return updated;
    pull = found.value;
  }
  const published = await publish(deps, adapter, vault, prepared.value.accepted, prepared.value.owners, proposal, pull);
  return published.ok ? ok({ pull, opened: found.value === undefined, policy: published.value.policy }) : published;
}

/** Re-evaluates an actor's proposal and publishes its statuses — after a review in the forge, or new attestations. */
export async function publishStatuses(
  deps: ForgeDeps, vault: VaultLocation, actor: string,
): Promise<Result<{ policy: PolicyStatus; checks: CommitStatus[] }, ForgeSyncError>> {
  const prepared = await prepare(deps, vault, actor);
  if (!prepared.ok) return prepared;
  const found = await prepared.value.adapter.findPullRequest(actorBranch(actor), MAIN_BRANCH);
  if (!found.ok) return found;
  return publish(deps, prepared.value.adapter, vault, prepared.value.accepted, prepared.value.owners, prepared.value.proposal, found.value);
}

/** Moves the local `main` forward to `to`, in the worktree that has it checked out or as a ref; false when it cannot move forward. */
async function forwardMain(git: Git, repo: string, to: Sha): Promise<Result<boolean, GitError>> {
  const tip = await mainTip(git, repo);
  if (!tip.ok) return tip;
  if (tip.value === to) return ok(false);
  if (tip.value !== null) {
    const behind = await isAncestor(git, repo, tip.value, to);
    if (!behind.ok) return behind;
    if (!behind.value) return ok(false);
  }
  const worktrees = await listWorktrees(git, repo);
  if (!worktrees.ok) return worktrees;
  const checkout = worktrees.value.find((w) => w.branch === MAIN_BRANCH);
  if (checkout === undefined) {
    const moved = await updateRef(git, repo, MAIN_REF, to, tip.value);
    return moved.ok ? ok(true) : moved;
  }
  const forwarded = await fastForward(git, checkout.path, to);
  if (forwarded.ok) return ok(true);
  // Uncommitted work in main's checkout is the owner's: leave main where it is.
  return forwarded.error.reason === 'dirty-worktree' ? ok(false) : forwarded;
}

/** Fetches the forge's `main` and notes: its `main` becomes the accepted main, and the local `main` follows it forward. */
export async function syncWithForge(
  deps: ForgeDeps, vault: VaultLocation,
): Promise<Result<{ accepted: AcceptedMain; mainUpdated: boolean }, ForgeSyncError>> {
  const adapter = await connect(deps, vault);
  if (!adapter.ok) return adapter;
  const met = await meetNotes(deps, vault, [`+${MAIN_REF}:${FORGE_MAIN}`]);
  if (!met.ok) return met;
  const forgeMain = await resolveRevision(deps.git, vault.path, FORGE_MAIN);
  if (!forgeMain.ok) return forgeMain;
  const mode = await requireForgeMode(deps.git, vault.path, forgeMain.value);
  if (!mode.ok) return mode;

  let accepted = acceptedMain(deps.store, vault.id);
  if (accepted?.sha !== forgeMain.value) {
    const account = await adapter.value.account();
    if (!account.ok) return account;
    const recorded = recordAccepted(deps.store, vault.id, { sha: forgeMain.value, how: 'sync', by: account.value, at: deps.clock.now() }, accepted?.sha ?? null);
    if (!recorded.ok) return recorded;
    accepted = recorded.value;
  }
  const forwarded = await forwardMain(deps.git, vault.path, forgeMain.value);
  return forwarded.ok ? ok({ accepted, mainUpdated: forwarded.value }) : forwarded;
}
