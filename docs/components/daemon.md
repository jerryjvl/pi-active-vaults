# Daemon

Runs the work that must happen while nobody is using Pi: timers, reactions to
Git changes, and queued spawns. One per machine, as a user service.

## Responsibilities

| Area | Behaviour |
|---|---|
| **Single instance** | Takes the daemon's record in the state database (process ID and start time, void once that process ends), then binds its socket. If another daemon holds either, it exits `0`, so a service manager does not restart it |
| **Git events** | Each vault's `reference-transaction` hook leaves a file named after the vault in `<state>/refs`; refs are also polled every minute |
| **Timers** | Evaluated each minute in the machine's time zone. A run is identified by its local date and scheduled time, so a daylight-saving change neither repeats nor skips it; `missed` applies on start |
| **Integrity** | On every ref change, checks for an unaccepted change; pauses that vault's automation and tells its owners once per unaccepted tip |
| **Matching, claims, scheduling** | Below |
| **Budgets** | Document budgets, cascade pools and the daily ceiling |
| **Traces** | Trace IDs, full logs, rotation |
| **Outbox** | Each minute, retries due notifications with backoff ([Notifications](../notifications.md)) |
| **Forge sync** | Below |
| **MCP server** | Serves each MCP profile that has an endpoint; one that cannot be served (unresolved token, address in use) is reported and the rest still are ([MCP](../mcp.md)) |

## Spawn lifecycle

```mermaid
stateDiagram-v2
  direction LR
  [*] --> queued: claimed
  queued --> running
  running --> committed
  running --> no_change: ended normally without changes
  committed --> recorded
  no_change --> recorded
  queued --> stopped
  running --> stopped
  stopped --> recorded
  recorded --> [*]
```

A spawn's identity is its document and the event that triggered it. Claiming
it is a unique insert, made before anything runs, so no spawn runs twice. Each
state change is one transaction.

| Stop reason | When |
|---|---|
| `budget`, `ttl` | Its budget or run time is used up |
| `error` | Its process failed, or its last model request ended in an error |
| `restart` | The daemon restarted while it ran |
| `queue-time` | Queued longer than `daemon.queue-time` |
| `requested` | Stopped through the socket |
| `no-session` | Its condition is `session-required` and the originating session is not known here |
| `no-model` | No `agent` model it may use: none configured, or not allowed by `policy` for its vault |

## Matching

Each job has a cursor per event stream: merges on the accepted `main`
(`merged`) and commits on each actor branch (`committed`). Events after the
cursor are matched, their spawns claimed and the cursor advanced, one event at
a time. Events come from Git history, so nothing is lost while the daemon is
down: on start it catches up from each cursor.

- A new job starts at the merge that introduced it. In a vault the daemon
  newly takes up, every cursor starts at the current history, so nothing
  earlier is replayed. A new actor branch starts where it left the accepted
  `main`.
- A paused vault's cursors wait until it is resolved.
- An event is matched in parts, one per run whose changes it holds (by
  `Vault-Trace`). Each part continues that run's session tree if the run is
  known here, else starts a new one; changes no run made start a new tree.
  Each part is a spawn identity of its own.
- A cursor whose commit has gone (rewritten history) restarts at the tip.

## Scheduling

Queued spawns start in the order of [Architecture](../architecture.md#scheduling),
at most `daemon.parallel` at a time, and one per actor. A spawn's actor is the
job's `actor`, and its model the job's `model` (else the default `agent`), both on
the accepted `main` at claim time. A spawn with no `agent` model it may use —
none configured, or not allowed for its vault by `policy` — is stopped with
`no-model` and reported by `vault doctor`. While the spawn's actor is running
a job, claimed by an earlier spawn or held by an interactive session, the
spawn waits in place. Nothing starts in a paused vault.

```yaml
daemon:
  queue-time: 24h   # default
  parallel: 1       # default: headless sessions at once, the capacity of Pi's model
```

## Execution

A spawn runs in its actor's worktree as

```
pi --mode rpc --model <agent model> --vault-run <state>/runs/<trace>.json --session-id <trace> [--fork <session file>]
```

It forks the originating session when that session subscribed here (giving
its file) and the condition's `context` is not `bare`. The daemon records the
process (ID and start time) first, starts the session, waits for Pi to settle
and closes its input; a run still going a minute past its `ttl` is killed.

The outcome comes from what was recorded: commits carrying the run's trace
make it `committed` (a later model error is noted in its log); otherwise a stop
reason above applies; a run that settled normally without committing is
`no-change`. The run's full log holds the daemon's steps and Pi's events
(without streaming deltas).

## Start-up recovery

Only one daemon runs, so nothing it started can still legitimately be running
when it starts. Before anything else it:

1. Ends headless sessions left from its previous run, by recorded process ID
   after checking the start time, so a reused ID is never touched. It never
   matches processes by name.
2. Stops every running spawn with `restart`, ending its budget session and
   releasing its actor.
3. Resets those actors' worktrees to their last commit, saving uncommitted
   changes to the run's full log first.
4. Leaves queued spawns queued.

Interactive sessions are not the daemon's; their holds stand while their
processes live. `vault doctor --fix` runs the same recovery when no daemon
runs, so for anything the daemon owns, restarting it is the remedy.

## Hosting

Two settings decide which daemon runs a vault's timer and Git-event jobs:

| `vault.executor` (root contract) | Runs on this installation when |
|---|---|
| unset | its `host: true` (installation config; default `false`) |
| this installation's name | always |
| another installation's name | never — `vault doctor` warns if `host: true` is set |

So nothing runs until someone opts in, and a vault can be pinned to one
machine however many clone it. An installation's name defaults to
`<user>@<hostname>`; `vault whoami` prints it. Spawns from an interactive
session run on that session's machine.

## Forge sync

Each minute, every `forge`-mode vault is fetched first: the forge's `main`
becomes the accepted `main`, the local `main` follows it forward, and merges
are matched like any other. For the vaults this daemon runs:

- **Proposals.** Each of the vault's `actors` with a proposal is kept current:
  when its head moves, the branch is pushed and its pull request opened or
  updated with its statuses; otherwise the statuses are republished every five
  minutes, to pick up reviews made in the forge. Failures show in `vault daemon
  status` and are retried the next minute.
- **Merge results.** Before fetching, it asks the forge for the most recently
  merged pull requests (one page); after fetching, it checks once whether each
  one's head is in the new `main`. One that is not — a squash or rebase merge —
  is reported once to the owners, naming the pull request and that its
  attestations and trace notes no longer attach.
- **Branches after a lost merge.** The daemon resets the actor branch to the
  accepted `main` only if its tip is exactly the approved head, no session
  holds the actor and its worktree has no change (untracked files included).
  Otherwise the report names the condition and the command to run (`git -C
  <worktree> reset --hard main`, or `git -C <vault> branch -f actor/<name>
  main` without a worktree). While the branch holds the approved head, `vault
  status` and `vault doctor` list the merge and no new pull request is opened;
  the listing ends by itself once it no longer does.
- **Pushes.** Never forced, with one exception: after such a reset, the
  forge's copy still holds the merged head, so the push replaces exactly that
  commit (`--force-with-lease` on it), and is refused if the copy is anything
  else. `main` is never pushed.

Attestation and trace notes are fetched, merged line by line and pushed.

## Socket protocol

JSON lines over a socket only the user can reach: `<state>/daemon.sock`, or on
Windows a named pipe named after the state directory. A request is `{ id,
method, params }`, answered `{ id, ok: true, result }` or `{ id, ok: false,
error: { reason, … } }`.

| Method | Params | Result |
|---|---|---|
| `ping` | — | `version`, `capabilities` |
| `spawn` | `vault`, `document`, `condition`, `event`, optional `parent`, `relevance` | The claimed spawn |
| `status` | — | `queued`, `running` (with process IDs), `paused`, `budgets`, `forge` per vault |
| `subscribe` | `trace`, optional `session` and its `file` | Notices for the spawns in that session's tree |
| `stop` | `trace` | The running spawn stops (`requested`) |

A `spawn` is claimed with the budget and actor of the job on the accepted
`main`, and only if that job's condition is a spawn condition the event
matches; otherwise, or in a paused vault, it is refused. A notice is `{
notice: "spawn", state: started | finished, trace, vault, document, parent?,
root?, outcome?, reason?, commit? }`.

## Service installation

`vault daemon install` writes a definition for the platform; `print-unit`
prints it without installing.

| Platform | Service |
|---|---|
| Linux | systemd user unit, `$XDG_CONFIG_HOME/systemd/user/pi-active-vaults.service` |
| macOS | launchd agent, `~/Library/LaunchAgents/pi-active-vaults.daemon.plist`; with `--headless`, for a Mac nobody logs in to, a launchd daemon in `/Library/LaunchDaemons/` run as the user, installed with `sudo` |
| Windows | Task Scheduler task `pi-active-vaults` at logon |

The service runs `vault daemon run` with a fixed `PATH`: the directories in
which `node`, `pi` and `git` were found when it was installed — as named on
`PATH`, without following links, so a version manager's `latest` or shim
directory keeps working across upgrades — ahead of the platform's usual ones.
No login shell is used: it would rebuild `PATH` from profiles, which a version
manager's interactive-shell setup does not reach. `vault doctor` warns when a
recorded directory no longer holds its tool; installing again fixes it.

## Log rotation

Full logs are kept per UTC day and trace. Earlier days are gzip-compressed;
days older than `logs.keep-days` (counting today) are deleted.
