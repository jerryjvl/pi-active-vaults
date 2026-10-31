# Pi extension

Brings vaults into interactive and headless Pi sessions. It exposes vault
operations as tools, supplies context as it becomes relevant, and guards what
the session may change. It is a thin adapter: the decisions are the core's
`sessions` module.

The registered surface is listed in [Pi API surface](../api.md).

## Session lifecycle

| Pi event | The extension |
|---|---|
| `session_start` | Loads the installation config; compiles the vault catalog; determines the session's actor and budget, and takes the actor's hold in the vault it runs in (or reports who holds it); connects to the daemon if one is running; handles the start as a session event |
| `before_agent_start` | Adds the vault catalog as a system-prompt section (stable, ordered by vault ID); adds what is waiting for the model — unaccepted-change notices, a run's brief or else where the session writes, `session.start` documents |
| `tool_call` | Applies the write guard; records session events — the tool, and each vault path it touches |
| `tool_result` | Records results needed for traces; marks the session tainted when it used an untrusted tool or read outside the vaults; appends the context the call's paths brought in |
| `turn_end` | Records the turn's tokens against the session budget, so a crash loses at most the turn in progress; compaction is recorded the same way |
| `session_shutdown` | Flushes the trace; releases the actor's holds; disconnects; releases resources |

## Behaviour

### Actor and budget

An interactive session writes as the actor whose worktree it runs in, else
the one given with `--vault-actor`, else the installation's `person` —
also when it runs outside every vault. It writes in every vault where that
actor is one of the `actors` or `owners`, each time in that actor's worktree
there. It holds the actor in the vault it runs in from its start, and in
any other from its first write there. A busy actor is reported with the
session holding it, and taken once free. The model is told at the start whom
it writes as and where.

`/vault actor <name>` changes the actor; only the person can, since it is a
command and not a tool. The session's holds are released, and work left
uncommitted stays in the old actor's worktree, with the commands to commit it
there. A name that writes in no vault changes nothing. A headless run always
writes as its job's actor.

An interactive session is the root of a session tree of its own, bounded only
by the daily ceiling; its work counts towards the day, and it is never
stopped.

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

Blocks file writes in a vault outside the session's actor worktree there
(including its Git internals) and writes while another session holds its
actor there; outside the vaults, an interactive session writes as Pi normally
would and a headless run not at all. A blocked write says where to write
instead, or why the session writes nowhere in that vault. Blocks shell commands that push, or would move `main`: commands
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
The session subscribes to the daemon's notices for its tree, giving its
session file so its spawns can fork it, and receives a short notice when
spawned work starts and finishes (also published as `pav:v1:spawn`).

### Commits

The commit tool runs blocking checks, then commits the work with
`Vault-Trace` (the session's trace), `Vault-Actor` and `Vault-Session`
trailers, and attaches the session's compact trace record as of that commit
as a note (concepts.md "Trace"). A record that cannot be written is reported;
the commit stands. Each tool result, each turn's work and the session's start
and end go to the trace's full log, `session`.

### Taint

A session is tainted once it uses any tool not in the installation's
`taint.trusted-tools`, or reads a file outside the registered vaults with Pi's
file tools. Unknown tools taint, so the check fails closed. Commits from a
tainted session carry a `Vault-Tainted` trailer, so merge rules with
`when-tainted` apply.

### Tool names

Some models call a tool by the name code mode's declarations show it under
(`tools.vault_script`), or as `functions.<name>`. As each of the model's
messages ends, such a call is renamed to the tool it means, before Pi runs it.
This happens in vault sessions and fan-out items alike, and the session's log
records it. A call is renamed only when its name belongs to no tool and the name
after the prefix does. A renamed call passes the same guards as any other.

## Headless sessions

The daemon runs jobs as `pi --mode rpc` sessions that load this same extension.
In headless mode the extension takes its actor, budget and trace context from
the daemon instead of from configuration: the run file given with `--vault-run`
is JSON with `vault`, `document`, `actor`, `model` (the name of the `agent` model
the daemon started it with), `trace` (the spawn's, whose allotment is its budget)
and `event`, and `grants` when the signer issued any ([Web grants](../concepts.md#web-grants)):
the script grant reaches its scripts in its vault as `VAULT_WEB_GRANT`, and the
item grant reaches its fan-out items' requests to the MCP servers named in
`web-grants.servers` as the header `X-Vault-Grant`. The run is briefed with its job document
as on the accepted `main` and the triggering event as structured data (see
[Concepts](../concepts.md#applies-when)). A run does not start without a
readable run file, an allotment, its job on the accepted `main`, a permitted
actor and its hold, or unless Pi is running it on that `agent` model, which
`policy` allows for its vault; it is stopped past its budget, run time or the daily
ceiling. A job with nothing to do ends without committing.
