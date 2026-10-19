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
to change accepted knowledge, and for every vault shared between people. Four
settings carry the guarantee; `vault doctor` checks each one through the forge's
API and reports what is missing. Where the API does not show the merge methods
to the executor's account, it warns that it cannot verify them; where it shows
`main`'s protection only to repository admins (Gitea), which the executor
should not be, it warns that you need to check the protection by hand.

| Setting | Value |
|---|---|
| **Executor credential** | A bot account or deploy key with write access to the repository, but **not an owner**. Owner credentials are never stored on executor machines. |
| **Protected `main`** | No direct pushes, no force pushes, no deletion; changes only through pull requests; the `vault/policy` status required. |
| **Required approval** | At least one approval from an owner, who is not the pull request's author. |
| **No squash or rebase merges** | Only merge commits or fast-forwards, which keep the proposal's commits. A squash replaces them with one new commit, a rebase with copies; the attestations and trace notes attached to the reviewed commits do not follow. |

The merge methods to turn off:

- **Gitea:** in the repository's settings under pull requests, untick "Create
  squash commit", "Rebase, then fast-forward" and "Rebase, then create merge
  commit".
- **GitHub:** Settings → General → Pull Requests, untick "Allow squash
  merging" and "Allow rebase merging".
- **GitLab:** Settings → Merge requests, set "Squash commits when merging" to
  "Do not allow", and leave "Enable automatic rebase prior to merge" off. With
  the fast-forward and semi-linear methods, a merge request's **Rebase** also
  replaces the proposal's commits.

Whatever the settings, when the daemon learns that a proposal was merged it
checks that the proposal's head is in the new `main`. If it is not, `vault
status` and `vault doctor` report it, and the vault's owners are told once.

On GitLab, statuses count as pipelines: require that pipelines succeed. A
GitLab approval names no commit, so `vault/policy` counts owners' approvals
only where approvals are reset when commits are pushed (a setting not every
tier offers).

`vault/policy` carries the vault's own merge policy — `when-tainted` rules,
judgements, control changes — to the forge. Without **Required approval**, it
alone decides, which suits a vault meant to merge on checks, such as an
agent-memory vault. That status is published by the executor, so a compromised
executor could fake it: keep owner approval required wherever that matters. The
forge enforces exactly what is configured; a loophole configured deliberately
stays open.

Optional, for more assurance:

- **Dismiss stale approvals** when new commits are pushed to a pull request.
- **Required checks run by the forge's CI** from the vault's `.vault/checks/`,
  rather than relying on statuses the executor publishes.

## Further hardening

For experienced administrators who want more than accident protection on a
single machine: run the daemon and headless sessions as a separate
operating-system user that cannot write the owner's repositories, and run
interactive agent sessions in an OS sandbox. These measures are not required by
the package and are not checked by `vault doctor`; a forge achieves the
important guarantee with far less to get wrong.
