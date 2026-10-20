# Security setup

How to deploy for the [security model](security.md).

## Local vaults

A `local` vault has one clone; use a forge for a vault on several machines.
The defaults suffice: `vault init` and `vault add` install each vault's Git
hooks (change monitoring and the pre-push guard), and `vault doctor` checks
that they stay installed, that state, configuration and the daemon socket are
accessible only to you (`--fix` repairs both), and that `notify` is configured
so unaccepted changes reach you when a daemon runs.

Day to day: when a command reports an unaccepted change, look at it with
`vault accept --adopt <sha>` and either confirm it or reset `main`.

## A service user on a shared machine

An installation run by a dedicated service account — a machine's always-on
executor — can keep its config where that account cannot change it: point
`PI_ACTIVE_VAULTS_CONFIG` at a directory owned by root and readable by the
service account's group (`750`, files `640`), with no access for anyone
else. Then a job that is talked into editing files cannot loosen its own model
policy, MCP profiles or forges. `vault doctor` accepts that ownership as
private; the daemon's service definition carries the variable (daemon.md
"Service installation"). Its state stays in the account's own directory.

## Forge vaults — the recommended setup

Use a forge for any vault where a misbehaving agent or machine must not be able
to change accepted knowledge, and for every vault shared between people. The
guarantee rests on a few settings; `vault doctor` checks what the forge's API
shows it and reports what is missing. Where the API does not show the merge
methods to the executor's account, it warns that it cannot verify them; where
it shows `main`'s protection only to repository admins (Gitea), which the
executor should not be, it warns that you need to check the protection by hand.

| Setting | Value |
|---|---|
| **Executor credential** | A bot account per machine that runs the package, with write access to the repository, but **not an owner** and not a repository admin. Owner credentials are never stored on executor machines. |
| **Protected `main`** | No direct pushes, no force pushes, no deletion; changes only through pull requests; the `vault/policy` status required. |
| **Required approval** | At least one approval from an owner, who is not the pull request's author; only owners' approvals count. |
| **Dismiss stale approvals** | A commit pushed to a pull request withdraws its approvals, so an approval always names the content merged. Required when the package merges for you (below). |
| **No squash or rebase merges** | Only merge commits or fast-forwards, which keep the proposal's commits. A squash replaces them with one new commit, a rebase with copies; the attestations and trace notes attached to the reviewed commits do not follow. |
| **Merging once approved** | The bot accounts may merge (merge allowlist): the package asks the forge to merge each proposal itself once it is approved and passing, so approving is the owner's only step. |

### Merging once approved

Approving is the decision: the approval names the exact commit, `vault/policy`
is computed from it, and the forge enforces both. Merging afterwards adds a
step to forget, not a check. So with each proposal it pushes, the package asks
the forge to merge the pull request **itself, at exactly that head, with a merge
commit, once the branch protection's required approvals and statuses are met**.
The owner approves; within a minute `vault/policy` turns green and the forge
merges.

The forge performs that merge as the account that asked — the executor's bot —
so the bots must be allowed to merge. That is safe because of what the forge
still requires: an approval **from an owner** (only owners are on the approval
allowlist; the bots cannot approve), **on the current head** (stale approvals
dismissed: a commit pushed later withdraws it), and `vault/policy`. A
compromised bot can therefore merge only what an owner approved, as approved.
Without "dismiss stale approvals" it could push something new and merge on an
old approval: do not allow the bots to merge without it.

`vault propose` says what happens after approval: "The forge merges it once it
is approved and vault/policy passes", or "Merge it by hand once approved" with
why — the forge refused because the account may not merge (add it to the merge
allowlist), the forge type has no such call yet, or the forge entry sets
`auto-merge: false`. A refusal is also in `vault daemon status`, and the daemon
asks again each pass, so fixing the allowlist takes effect without a new
proposal. Gitea is supported; on GitHub and GitLab the package does not yet ask,
and says so: merge by hand there.

A merge queue (testing each merge against the latest `main` before it lands) is
not needed at a vault's volume: Git refuses conflicting merges, and checks run
again on everything that follows.

### Gitea, step by step

Names below are Gitea 1.27's; the API field is given where the label may differ
between versions.

1. **Organization and repositories.** One organization for the vaults, one
   repository per vault, `main` as the default branch and as the default target
   branch for new pull requests (repository Settings → Pull requests). Create
   `main` first: a repository whose first pushed branch is an actor branch takes
   that as its default.
2. **Bot accounts.** One per machine that runs the package (for example
   `vault-laptop`, `vault-studio`), each in a team of the organization with
   **Write** to *Code* and *Pull Requests* on the repositories that machine
   uses — not *Administrator*. Give each bot an SSH key for its machine, and an
   API token with *repository: Read and Write* and *user: Read*. The owner keeps
   their own account; it is never configured on an executor.
3. **Merge styles** (repository Settings → Pull requests): leave **Create merge
   commit** ticked; untick **Create squash commit**, **Rebase then fast-forward**
   and **Rebase then create merge commit** (`allow_squash_merge`, `allow_rebase`,
   `allow_rebase_explicit`). "Fast-forward only" keeps the commits and may stay.
4. **Branch protection** for `main` (repository Settings → Branches → add a rule
   with the pattern `main`):

   | Setting | Value | API field |
   |---|---|---|
   | Push | **Disable push** | `enable_push: false` |
   | Force push | off | `enable_force_push: false` |
   | Required approvals | **1** (or more) | `required_approvals` |
   | Restrict approvals to allowlisted users or teams | on, **the owners only** | `enable_approvals_whitelist`, `approvals_whitelist_username` |
   | Dismiss stale approvals | **on** | `dismiss_stale_approvals: true` |
   | Enable status check | on, pattern **`vault/policy`** | `enable_status_check`, `status_check_contexts` |
   | Merge | **Enable Merge Allowlist**: the owners **and the bot teams** | `enable_merge_whitelist`, `merge_whitelist_usernames`, `merge_whitelist_teams` |
   | Block merge if pull request is outdated | off: it would make every merge wait for a branch update and a fresh approval | `block_on_outdated_branch: false` |

   "Enable Merge" (any writer may merge) is as safe today — the approval gate
   is the same — but the allowlist stays right if someone is later given write
   access without the right to merge.
5. **The installation's config.** A `forges` entry for the host, with the
   bot's token (`token: "!<command that prints it>"`) and `api:` where the API
   is not at `https://<host>/api/v1` (a non-standard port). The vault's
   registration names the remote that points at the repository (`remote:`).
   `auto-merge` defaults to true.
6. **Check.** `vault doctor` on each machine: it reports the merge styles, and
   that it cannot read the protection with a bot's access — check that by hand
   against the table above. Then propose something small and approve it: it
   should merge itself within a minute.

### GitHub and GitLab

The merge methods to turn off:

- **GitHub:** Settings → General → Pull Requests, untick "Allow squash
  merging" and "Allow rebase merging".
- **GitLab:** Settings → Merge requests, set "Squash commits when merging" to
  "Do not allow", and leave "Enable automatic rebase prior to merge" off. With
  the fast-forward and semi-linear methods, a merge request's **Rebase** also
  replaces the proposal's commits.

On GitLab, statuses count as pipelines: require that pipelines succeed. A
GitLab approval names no commit, so `vault/policy` counts owners' approvals
only where approvals are reset when commits are pushed (a setting not every
tier offers).

### Whatever the forge

Whatever the settings, when the daemon learns that a proposal was merged it
checks that the proposal's head is in the new `main`. If it is not, `vault
status` and `vault doctor` report it, and the vault's owners are told once.

`vault/policy` carries the vault's own merge policy — `when-tainted` rules,
judgements, control changes — to the forge. Without **Required approval**, it
alone decides, which suits a vault meant to merge on checks, such as an
agent-memory vault. That status is published by the executor, so a compromised
executor could fake it: keep owner approval required wherever that matters. The
forge enforces exactly what is configured; a loophole configured deliberately
stays open.

Optional, for more assurance: **required checks run by the forge's CI** from the
vault's `.vault/checks/`, rather than relying on statuses the executor publishes.

## Further hardening

For experienced administrators who want more than accident protection on a
single machine: run the daemon and headless sessions as a separate
operating-system user that cannot write the owner's repositories, and run
interactive agent sessions in an OS sandbox. These measures are not required by
the package and are not checked by `vault doctor`; a forge achieves the
important guarantee with far less to get wrong.
