# Security model

What the package guarantees about unreviewed changes, and where those guarantees
are enforced.

## Starting assumption

A vault is a plain Git repository on a machine. **Any process running as the
same operating-system user can change anything in it** — files, branches,
`main`, hooks, configuration, and the package's own state. Agents with a shell
are such processes.

So the package makes two different promises:

| Setup | Promise |
|---|---|
| **Local** (plain Git) | Unexpected changes to `main` are **noticed** and never run as code or instructions until an owner accepts them. This protects against accidents and confused agents, not against a process deliberately working around it. |
| **Forge** (Gitea, GitHub, GitLab) | Nothing reaches the shared vault's `main` without an owner's approval — **enforced by the forge**, independent of any local machine. This is the guarantee to rely on when it matters. |

## The accepted `main`

Each vault has an **accepted `main`**: the commit the owner last accepted.

| Mode | Accepted `main` |
|---|---|
| `local` | The commit `vault accept` last produced or adopted, recorded in the state database |
| `forge` | The forge's `main` as last fetched — protected by the forge |

**Everything executable or instructional is resolved from the accepted `main`**,
never from the current tip of `main`, a branch or a working tree:

- vault scripts, checks and job documents;
- contracts and `applies-when` conditions;
- Git events for triggers (derived up to the accepted `main`);
- the search index (built up to the accepted `main`).

A commit on `main` that the owner has not accepted runs nothing and triggers
nothing.

## Unexpected changes

When the tip of `main` differs from the accepted `main` — new commits, a reset,
a rewrite — the vault has an **unaccepted change**:

- **Every command reports it.** Each `vault` CLI command, each Pi session using
  the vault, and each MCP response for the vault carries a notice naming the
  vault and the unaccepted commit, until it is resolved.
- **Automation pauses for that vault.** Triggers, spawns and script runs stop;
  reading, search, review and interactive work continue.
- **The owner is notified once** through `builtin:notify`, when a daemon is
  running.

It is resolved only by an explicit owner act:

| Resolution | Command |
|---|---|
| Accept the change | `vault accept --adopt <sha>` shows the commits and diff from the accepted `main` to `<sha>`, flags any rewritten history, and asks for confirmation before recording `<sha>` as accepted |
| Discard it | Reset `main` to the accepted `main` with Git, then run any command to confirm |

In `forge` mode, a local `main` that differs from the fetched forge `main` is
reported the same way; it is resolved by syncing with the forge, never by
adopting locally.

## Safeguards

| Safeguard | Mode | Protects against |
|---|---|---|
| Executable content only from the accepted `main` | Both | A stray commit on `main` running as code or instructions |
| Notice on every command until adopted | Both | Unexpected changes going unnoticed |
| Automation pauses on unaccepted changes | Both | Triggers acting on unreviewed state |
| Pre-push hook refusing pushes of `main` | Both | Accidental pushes of unreviewed work |
| The package never pushes `main` | Forge | The package itself bypassing review |
| Bot credential that is not an owner | Forge | An executor approving its own proposals |
| Protected `main` with required owner approval | Forge | Anything reaching the shared `main` unreviewed — even from a compromised machine |
| Content is data | Both | Text in documents, pages or tool results acting as instructions |

## What is not guaranteed

- **Locally, a deliberate same-user process can defeat the safeguards** — for
  example by editing the state database. Local mode is about accidents. Use a
  forge where a misbehaving agent must not be able to change accepted knowledge.
- **A process with the owner's forge credentials can do anything the owner
  can.** Keep owner credentials off executor machines.
- **Local data can be destroyed.** The forge, or another backup, is the recovery
  path.

## Requirements on the implementation

- The accepted `main` is read and written only by the core's `integrity` module;
  every component asks it before acting.
- Every propagating action — trigger, spawn, script run, index update, push —
  checks for an unaccepted change first, and refuses if there is one.
- Every user-facing surface (CLI, Pi, MCP) shows the unaccepted-change notice.
- Each safeguard has a test demonstrating that its bypass is noticed or refused.
