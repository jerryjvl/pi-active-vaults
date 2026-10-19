// Forge mode (concepts.md "Actor", security.md): proposals go to the forge as
// pull requests, the forge merges under its branch protection, and the
// package learns of merges by fetching.
//
// Invariants:
//  - the package pushes only actor branches and its notes (attestations and
//    traces) — each to the same name — never `main`: `pushToForge` refuses
//    any other refspec before git runs. Nothing is forced but one case: an
//    actor branch replacing the forge's copy when that is exactly the head
//    the forge reported merged, as a lease on that commit;
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

import { ATTESTATIONS_REF, type Attestation, type AttestationError } from '../attestations/index.ts';
import { actorBranch, readProposal, type Proposal, type ProposalError } from '../actors/index.ts';
import type { Clock } from '../clock/index.ts';
import type { ForgeEntry } from '../config/index.ts';
import {
  fastForward, fetchRefs, isAncestor, listWorktrees, notesMergeLines, pushRefs, remoteRef, remoteUrl, resolveRevision, updateRef,
  type Attribution, type Git, type GitError, type Lease, type Sha,
} from '../git/index.ts';
import {
  MAIN_BRANCH, acceptedMain, mainTip, recordAccepted, requireNoUnacceptedChange,
  type AcceptedMain, type AcceptedReads, type UnacceptedChangeError, type VaultLocation,
} from '../integrity/index.ts';
import { evaluateMerge, type CheckStatus, type PolicyError } from '../policy/index.ts';
import { readVaultIdentity, type IdentityError } from '../registry/index.ts';
import { err, ok, type Result } from '../result/index.ts';
import type { Store } from '../store/index.ts';
import { TRACES_REF } from '../traces/index.ts';
import { POLICY_CONTEXT, type CommitStatus, type ForgeAdapter, type ForgeDepsBase, type ForgeError, type PullRequest, type StatusState } from './adapter.ts';
import { mergedHeads } from './merged.ts';
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
  | { readonly reason: 'accepted-moved'; readonly current: Sha | null }
  | { readonly reason: 'not-proposed'; readonly actor: string };

/** What publishing a proposal's statuses sent, and the requirements of its merge policy still unmet. */
export interface Published {
  readonly policy: PolicyStatus;
  readonly checks: CommitStatus[];
  readonly unmet: string[];
}

/** The remote a forge-mode vault's forge is on, unless its registration names another. */
export const DEFAULT_REMOTE = 'origin';
export const remoteOf = (vault: { readonly remote?: string }): string => vault.remote ?? DEFAULT_REMOTE;
const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const forgeMainOf = (remote: string): string => `refs/remotes/${remote}/${MAIN_BRANCH}`;
// The notes that travel with a vault: attestations and traces, merged line by line.
const SHARED_NOTES = [ATTESTATIONS_REF, TRACES_REF] as const;
// The forge's notes are fetched beside ours, then merged into ours.
const NOTES_PREFIX = 'refs/notes/vault/';
const FORGE_NOTES_PREFIX = 'refs/notes/vault-forge/';
const forgeCopy = (ref: string): string => `${FORGE_NOTES_PREFIX}${ref.slice(NOTES_PREFIX.length)}`;

/**
 * Only actor branches and the package's notes, each pushed to its own name,
 * and never forced — except by a `lease` on an actor branch among them (see
 * `leaseOnMergedHead`), which may replace the forge's copy only while it
 * holds exactly the commit the lease names.
 */
export async function pushToForge(git: Git, repo: string, refspecs: readonly string[], options: { readonly lease?: Lease; readonly remote?: string } = {}): Promise<Result<void, ForgeSyncError>> {
  for (const refspec of refspecs) {
    const [source, destination, ...rest] = refspec.split(':');
    const own = source === destination && rest.length === 0;
    if (!own || source === undefined || !(source.startsWith('refs/heads/actor/') || (SHARED_NOTES as readonly string[]).includes(source))) return err({ reason: 'not-pushable', refspec });
  }
  if (options.lease !== undefined && !options.lease.ref.startsWith('refs/heads/actor/')) return err({ reason: 'not-pushable', refspec: options.lease.ref });
  return pushRefs(git, repo, options.remote ?? DEFAULT_REMOTE, refspecs, options.lease === undefined ? {} : { lease: options.lease });
}

/**
 * The one case in which an actor branch is pushed forced. After a squash or
 * rebase merge the package resets the branch to `main`, so its next head is
 * not a fast-forward of the forge's copy, which still holds the head the
 * forge reported merged (`merged.ts`). Replacing exactly that commit loses
 * nothing — it is merged, and `main` is not touched — so the push leases it:
 * it is refused if the forge's copy is anything else, someone's later push
 * included. Undefined when a plain push does.
 */
async function leaseOnMergedHead(deps: ForgeDeps, vault: VaultLocation, actor: string, branchRef: string): Promise<Result<Lease | undefined, ForgeSyncError>> {
  const forgeHead = await remoteRef(deps.git, vault.path, remoteOf(vault), branchRef);
  if (!forgeHead.ok) return forgeHead;
  if (forgeHead.value === undefined || !mergedHeads(deps.store, vault.id, actor).includes(forgeHead.value)) return ok(undefined);
  const ahead = await resolveRevision(deps.git, vault.path, branchRef);
  if (!ahead.ok) return ahead;
  if (ahead.value === forgeHead.value) return ok(undefined);
  const forwards = await isAncestor(deps.git, vault.path, forgeHead.value, ahead.value);
  return ok(forwards.ok && forwards.value ? undefined : { ref: branchRef, sha: forgeHead.value });
}

/** The adapter for the vault's forge: the one its remote (`origin` unless registered otherwise) is on. */
export async function connectForge(deps: ForgeDeps, vault: VaultLocation): Promise<Result<ForgeAdapter, ForgeSyncError>> {
  const remote = remoteOf(vault);
  const url = await remoteUrl(deps.git, vault.path, remote);
  if (!url.ok) return url;
  if (url.value === undefined) return err({ reason: 'no-remote', remote });
  const found = forgeProject(deps.forges, url.value);
  return found.ok ? ok(forgeAdapter(found.value.entry, found.value.project, deps)) : found;
}

async function requireForgeMode(git: Git, repo: string, sha: Sha): Promise<Result<readonly string[], ForgeSyncError>> {
  const identity = await readVaultIdentity(git, repo, sha);
  if (!identity.ok) return identity;
  return identity.value.review === 'forge' ? ok(identity.value.owners) : err({ reason: 'not-forge-mode' });
}

/** Fetches the forge's notes and merges each into ours, line by line. */
async function meetNotes(deps: ForgeDeps, vault: VaultLocation, also: readonly string[] = []): Promise<Result<void, ForgeSyncError>> {
  const fetched = await fetchRefs(deps.git, vault.path, remoteOf(vault), [...also, `+${NOTES_PREFIX}*:${FORGE_NOTES_PREFIX}*`]);
  if (!fetched.ok) return fetched;
  for (const ref of SHARED_NOTES) {
    const theirs = await resolveRevision(deps.git, vault.path, forgeCopy(ref));
    if (!theirs.ok && theirs.error.reason === 'unknown-revision') continue;
    if (!theirs.ok) return theirs;
    const merged = await notesMergeLines(deps.git, vault.path, ref, forgeCopy(ref), deps.attribution);
    if (!merged.ok) return merged;
  }
  return ok(undefined);
}

/** The package's notes refs that exist here, to push. */
async function presentNotes(git: Git, repo: string): Promise<Result<string[], ForgeSyncError>> {
  const present: string[] = [];
  for (const ref of SHARED_NOTES) {
    const resolved = await resolveRevision(git, repo, ref);
    if (resolved.ok) present.push(ref);
    else if (resolved.error.reason !== 'unknown-revision') return resolved;
  }
  return ok(present);
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
): Promise<Result<Published, ForgeSyncError>> {
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
  return ok({ policy, checks, unmet: unmet.map((r) => r.requirement) });
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
  const adapter = await connectForge(deps, vault);
  return adapter.ok ? ok({ accepted: accepted.value, owners: owners.value, proposal: proposal.value, adapter: adapter.value }) : adapter;
}

function describe(proposal: Proposal): { title: string; body: string } {
  return {
    title: `Proposal from ${proposal.actor}`,
    body: [`Commits on ${proposal.branch}:`, '', ...proposal.commits.map((c) => `- ${c.subject}`), '', 'Opened by pi-active-vaults.'].join('\n'),
  };
}

/** Pushes an actor's proposal and the package's notes, opens or updates its pull request, and publishes its statuses. */
export async function proposeToForge(
  deps: ForgeDeps, vault: VaultLocation, actor: string,
): Promise<Result<{ pull: PullRequest; opened: boolean; policy: PolicyStatus; unmet: string[] }, ForgeSyncError>> {
  const prepared = await prepare(deps, vault, actor);
  if (!prepared.ok) return prepared;
  const { proposal, adapter } = prepared.value;
  const met = await meetNotes(deps, vault);
  if (!met.ok) return met;
  const branchRef = `refs/heads/${proposal.branch}`;
  const notes = await presentNotes(deps.git, vault.path);
  if (!notes.ok) return notes;
  const lease = await leaseOnMergedHead(deps, vault, actor, branchRef);
  if (!lease.ok) return lease;
  const pushed = await pushToForge(deps.git, vault.path, [branchRef, ...notes.value].map((ref) => `${ref}:${ref}`), { remote: remoteOf(vault), ...(lease.value === undefined ? {} : { lease: lease.value }) });
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
  return published.ok ? ok({ pull, opened: found.value === undefined, policy: published.value.policy, unmet: published.value.unmet }) : published;
}

/**
 * Re-evaluates an actor's proposal and publishes its statuses — after a review in the forge, or new attestations.
 * Only while the forge has it proposed: an open pull request whose head is the proposal's; `not-proposed` otherwise,
 * so statuses never land on a commit the forge was not given.
 */
export async function publishStatuses(
  deps: ForgeDeps, vault: VaultLocation, actor: string,
): Promise<Result<Published, ForgeSyncError>> {
  const prepared = await prepare(deps, vault, actor);
  if (!prepared.ok) return prepared;
  const found = await prepared.value.adapter.findPullRequest(actorBranch(actor), MAIN_BRANCH);
  if (!found.ok) return found;
  if (found.value === undefined || found.value.headSha !== prepared.value.proposal.head) return err({ reason: 'not-proposed', actor });
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
  const adapter = await connectForge(deps, vault);
  if (!adapter.ok) return adapter;
  const met = await meetNotes(deps, vault, [`+${MAIN_REF}:${forgeMainOf(remoteOf(vault))}`]);
  if (!met.ok) return met;
  const forgeMain = await resolveRevision(deps.git, vault.path, forgeMainOf(remoteOf(vault)));
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
