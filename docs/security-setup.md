# Security setup

How to deploy for the [security model](security.md).

## Local vaults

Nothing to configure beyond the defaults. `vault doctor --fix` makes sure that:

- the package's Git hooks are installed in each vault (change monitoring and the
  pre-push guard);
- state, configuration and the daemon socket are accessible only to the user;
- `notify` is configured, so unaccepted changes reach you when a daemon runs.

Day to day: when a command reports an unaccepted change, look at it with
`vault accept --adopt <sha>` and either confirm it or reset `main`.

## Forge vaults — the recommended setup

Use a forge for any vault where a misbehaving agent or machine must not be able
to change accepted knowledge, and for every vault shared between people. Three
settings carry the guarantee; `vault doctor` checks each one through the forge's
API and reports what is missing.

| Setting | Value |
|---|---|
| **Executor credential** | A bot account or deploy key with write access to the repository, but **not an owner**. Owner credentials are never stored on executor machines. |
| **Protected `main`** | No direct pushes, no force pushes, no deletion; changes only through pull requests. |
| **Required approval** | At least one approval from an owner, who is not the pull request's author. |

Optional, for more assurance:

- **Dismiss stale approvals** when new commits are pushed to a pull request.
- **Required checks run by the forge's CI** from the vault's `.vault/checks/`,
  rather than relying on statuses the executor publishes.
- **Required signed commits** on `main`, where the forge supports it.

## Further hardening

For experienced administrators who want more than accident protection on a
single machine: run the daemon and headless sessions as a separate
operating-system user that cannot write the owner's repositories, and run
interactive agent sessions in an OS sandbox. These measures are not required by
the package and are not checked by `vault doctor`; a forge achieves the
important guarantee with far less to get wrong.
