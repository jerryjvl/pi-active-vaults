# Pi extension

Brings vaults into interactive and headless Pi sessions. It exposes vault
operations as tools, supplies context as it becomes relevant, and guards what
the session may change. It is a thin adapter: the decisions are the core's
`sessions` module.

The registered surface is listed in [Pi API surface](../api.md).

## Session lifecycle

| Pi event | The extension |
|---|---|
| `session_start` | Loads the installation config; compiles the vault catalog; determines the session's actor and budget, and takes the actor's hold (or reports who holds it); connects to the daemon if one is running; handles the start as a session event |
| `before_agent_start` | Adds the vault catalog as a system-prompt section (stable, ordered by vault ID); adds what is waiting for the model — unaccepted-change notices, a run's brief, `session.start` documents |
| `tool_call` | Applies the write guard; records session events — the tool, and each vault path it touches |
| `tool_result` | Records results needed for traces; marks the session tainted when it used an untrusted tool or read outside the vaults; appends the context the call's paths brought in |
| `turn_end` | Records the turn's tokens against the session budget, so a crash loses at most the turn in progress; compaction is recorded the same way |
| `session_shutdown` | Flushes the trace; releases the actor; disconnects; releases resources |

## Behaviour

### Actor and budget

An interactive session writes in the vault it runs in, as the actor whose
worktree it runs in, else the one given with `--vault-actor`, else the
installation's `person`; its edits go to that actor's worktree. A session
outside every vault writes as no actor. An interactive session is the root of
a session tree of its own, bounded only by the daily ceiling; its work counts
towards the day, and it is never stopped. A busy actor is reported with the
session holding it, and taken once free.

### Unaccepted changes

When a vault's `main` has an unaccepted change, the extension reports it at
session start and with every vault tool result for that vault, and resolves
scripts, jobs and contracts from the accepted `main` only.

### Context injection

When a session first reads or edits a path in a vault — through Pi's file
tools or a vault tool — the extension appends the effective contract's prose
for that path and any matching `inject` documents to that call's result. Each
contract and document is injected at most once per session, and only from the
accepted `main`. Injection appends; it never rewrites earlier context.

### Write guard

Blocks file writes outside the session's actor worktree (including its Git
internals) and writes while another session holds its actor; outside the
vaults, an interactive session writes as Pi normally would and a headless run
not at all. Blocks shell commands that push, or would move `main`: commands
are read as words, following `cd`, `git -C` and command substitutions. Blocked
calls return an explanation the model can act on. The guard is a safety net for
agent mistakes, not a security boundary (see [Security model](../security.md)).

Control changes (contracts, `.vault/`, conditions, budgets and actors) are not
blocked: they are allowed on the actor's branch and require an owner at merge.

### Spawns

A session's start, each tool it uses and each vault path it touches are session
events, each counted once per session. One that matches a `spawn` condition
becomes a spawn request in the session's tree. With the daemon running, it is
sent there; otherwise it is queued in the state database. Its identity — the
document, and the session with what happened — is fixed before either, so a
request that reached the daemon and was also queued after a lost reply is still
one spawn. A commit requests what its `committed` event matches the same way.
The session receives a short notice when spawned work starts and finishes.

### Commits

The commit tool writes the session's compact trace record into the worktree,
runs blocking checks, then commits it with the work, with `Vault-Trace` (the
session's trace), `Vault-Actor` and `Vault-Session` trailers. The record alone
is never a commit. Each tool result, each turn's work and the session's start
and end go to the trace's full log, `session`.

### Taint

A session is tainted once it uses any tool not in the installation's
`taint.trusted-tools`, or reads a file outside the registered vaults with Pi's
file tools. Unknown tools taint, so the check fails closed. Commits from a
tainted session carry a `Vault-Tainted` trailer, so merge rules with
`when-tainted` apply.

## Headless sessions

The daemon runs jobs as `pi --mode rpc` sessions that load this same extension.
In headless mode the extension takes its actor, budget and trace context from
the daemon instead of from configuration: the run file given with `--vault-run`
is JSON with `vault`, `document`, `actor`, `trace` (the spawn's, whose
allotment is its budget) and `event`. The run is briefed with its job document
as on the accepted `main` and the triggering event as structured data (see
[Concepts](../concepts.md#applies-when)). A run whose file cannot be read, or
that has no allotment, no job on the accepted `main`, an actor that is not one
of the vault's `actors` or no hold, does not start; one past its budget, run time or the daily ceiling is
stopped. A job that decides there is nothing to do ends without committing.
