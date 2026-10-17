# Daemon

Runs the work that must happen while nobody is using Pi: timers, reactions to
Git changes, and queued spawns. One per machine, as a user service.

## Responsibilities

| Area | Behaviour |
|---|---|
| **Git events** | A `reference-transaction` hook installed in each registered vault notifies the daemon of ref updates; it also polls refs every minute as a fallback |
| **Single instance** | Binds its socket on start; if another daemon already holds it, exits |
| **Timers** | Evaluates timer conditions each minute; applies `missed` on start. A timer run is identified by its local date and scheduled time, so a clock change (daylight saving) neither repeats nor skips it |
| **Matching** | Derives events from each job's cursor up to the accepted `main` and matches `applies-when` conditions |
| **Integrity** | On every ref change, checks for an unaccepted change to `main`; pauses the vault's automation and notifies the owner once |
| **Claims** | Claims each spawn with a unique insert in the state database, so no spawn runs twice |
| **Scheduling** | Orders queued spawns by priority and runs them within each model's capacity, one job per actor at a time |
| **Budgets** | Enforces document budgets, cascade pools and the installation's daily ceiling |
| **Execution** | Starts `pi --mode rpc` with the spawn's context: forked from the originating session when available, fresh otherwise |
| **Traces** | Issues trace IDs, writes full logs and rotates them |
| **Outbox** | Retries undelivered notifications with backoff |
| **Forge sync** | For `forge`-mode vaults: pushes actor branches, keeps pull requests, commit statuses and the `vault/policy` status current, fetches to detect merges; merges attestation notes line by line |
| **MCP server** | Serves each configured MCP profile on its own endpoint — see [MCP](../mcp.md) |

## Spawn lifecycle

```mermaid
stateDiagram-v2
  direction LR
  [*] --> matched
  matched --> claimed
  claimed --> queued
  queued --> running
  running --> committed
  running --> no_change: ended without changes
  committed --> recorded
  no_change --> recorded
  queued --> stopped: budget or ttl
  running --> stopped: budget, ttl, error or restart
  stopped --> recorded
  recorded --> [*]
```

A spawn's identity is its document and the event that triggered it. The claim
is recorded before anything runs; a second claim for the same identity fails
and is ignored. Each state change is one transaction, so a crash leaves every
spawn in exactly one state.

## Start-up recovery

Only one daemon runs, so nothing it started can still be legitimately running
when it starts. Before anything else it returns its own state to a clean slate:

1. Ends any headless session left from its previous run, by the exact process
   ID it recorded, after checking that process's start time so a reused ID is
   never touched. It never matches processes by name.
2. Marks every running spawn `stopped` with the reason `restart`, ending its
   budget session and releasing its actor.
3. Resets the worktree of each actor those spawns held to the actor's last
   commit, first saving any uncommitted changes to the run's full log.
4. Leaves queued spawns queued; they keep their queue-time limit.

Interactive Pi sessions are not the daemon's and are left alone: their actor
holds stay valid while their processes live.

`vault doctor --fix` runs the same recovery when no daemon is running. For
anything the daemon owns, restarting it is the remedy.

## Catch-up

Events come from Git history, so nothing is lost while the daemon is down. On
start, after recovery, it derives events from each cursor up to the accepted
`main` and processes them in order.

## Hosting

Two independent settings decide which daemon runs a vault's timer and Git-event
jobs:

| Setting | Where | Default | Effect |
|---|---|---|---|
| `host` | The vault's entry in the installation config | `false` | This installation opts in to running the vault's jobs |
| `executor` | `vault.executor` in the vault's root contract | unset | Only the named installation may run the vault's jobs |

| `executor` | Runs on this installation when |
|---|---|
| unset | `host: true` |
| this installation's name | always |
| another installation's name | never — `vault doctor` warns if `host: true` is also set |

So nothing runs until someone opts in, and a vault can be pinned to one place
regardless of how many machines clone it.

An installation's name defaults to `<user>@<hostname>` and can be set in the
installation config. `vault whoami` prints it — the value to put in
`vault.executor`.

Spawns from interactive sessions always run on the machine of that session.

## Socket protocol

JSON lines over a local socket accessible only to the user (a Unix domain
socket; a named pipe on Windows).

| Method | Purpose |
|---|---|
| `ping` | Version and capabilities |
| `spawn` | Submit a spawn request |
| `status` | Queue, running sessions, budgets |
| `subscribe` | Receive start and finish notices for a session's spawns |
| `stop` | Stop a running spawn |

## Service installation

`vault daemon install` writes a definition for the platform:

| Platform | Service |
|---|---|
| Linux | systemd user unit |
| macOS | launchd agent (a launchd daemon with a user on headless machines) |
| Windows | Task Scheduler task at logon |

The service runs a launcher that resolves the current Node and `pi` at start,
so upgrades do not break it.

## Log rotation

Full logs are kept per day and trace. Today's files stay as written; files from
earlier days are gzip-compressed; days older than `logs.keep-days` (counting
today) are deleted. Days are UTC dates.
