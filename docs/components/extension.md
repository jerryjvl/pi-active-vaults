# Pi extension

Brings vaults into interactive and headless Pi sessions. It exposes vault
operations as tools, supplies context as it becomes relevant, and guards what
the session may change.

The registered surface is listed in [Pi API surface](../api.md).

## Session lifecycle

| Pi event | The extension |
|---|---|
| `session_start` | Loads the installation config; compiles the vault catalog; determines the session's actor and budget; connects to the daemon if one is running; injects `session.start` documents |
| `before_agent_start` | Adds the vault catalog to the system prompt (stable, ordered by vault ID) |
| `tool_call` | Applies the write guard; records session events; injects contracts and `inject` documents for newly touched paths |
| `tool_result` | Records results needed for traces; marks the session tainted when it read untrusted content |
| `turn_end` | Accounts tokens against the session budget |
| `session_shutdown` | Flushes the trace; disconnects; releases resources |

## Behaviour

### Unaccepted changes

When a vault's `main` has an unaccepted change, the extension reports it at
session start and with every vault tool result for that vault, and resolves
scripts, jobs and contracts from the accepted `main` only.

### Context injection

When a session first reads or edits a path, the extension appends the effective
contract's prose for that path and any matching `inject` documents. Each
document is injected at most once per session. Injection appends; it never
rewrites earlier context.

### Write guard

Blocks file writes outside the session's actor worktree (including its Git
internals), and shell commands that would move `main` or push. Blocked calls
return an explanation the model can act on. The guard is a safety net for agent
mistakes, not a security boundary (see [Security model](../security.md)).

Control changes (contracts, `.vault/`, conditions and budgets) are not blocked:
they are allowed on the actor's branch and require an owner at merge.

### Spawns

A session event or a commit that matches a `spawn` condition becomes a spawn
request. With the daemon running, it is sent there; otherwise it is queued in
the state database. The session receives a short notice when spawned work starts
and finishes.

### Commits

The commit tool runs blocking checks, then commits with `Vault-Trace`, `Vault-Actor`
and `Vault-Session` trailers.

### Taint

A session is tainted once it uses any tool not in the installation's
`taint.trusted-tools`, or reads a file outside the registered vaults. Unknown
tools taint, so the check fails closed. Commits from a tainted session carry a
`Vault-Tainted` trailer, so merge rules with `when-tainted` apply.

## Headless sessions

The daemon runs jobs as `pi --mode rpc` sessions that load this same extension.
In headless mode the extension takes its actor, budget and trace context from
the daemon instead of from configuration.
