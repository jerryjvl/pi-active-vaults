# Pi API surface

Everything the extension registers with Pi. Names are stable; changes are
versioned. Other packages may call the tools (`ctx.executeTool`) and listen on
the events.

## Tools

Tools are generated from the core's catalogue of operations; a tool's name is
`vault_` followed by the operation's name. `vault_fan_out` is the exception: it
orchestrates sessions, so it exists only in Pi.

All tools take vault paths as `<vault-id>:<path>`; a tool over many vaults takes
`vaults`, and otherwise the vault is the one the path names, the one the
session's directory is in, or the session's own. Results carry text for the
model and `structuredContent` — `{ status, data, text, notices }`, as the
CLI's `--json` — for programmatic callers.

| Tool | Exposure | Parameters | Returns |
|---|---|---|---|
| `vault_search` | `direct` | `query`, `vaults?`, `scope?`, `limit?` | Ranked hits: path, heading, excerpt, freshness |
| `vault_read` | `direct` | `path`, `range?` | Content, freshness against the accepted `main` |
| `vault_contract` | `codemode` | `path` | Effective contract with the origin of each key |
| `vault_commit` | `direct` | `message`, `paths?` | Commit SHA and what it spawned, or the checks that blocked it |
| `vault_script` | `direct` | `name`, `args?` | Exit status and output of an approved script |
| `vault_fan_out` | `direct` | `items` (a list, or `scratch:<name>` holding one as a JSON array of strings), `each`, `gather?`, `mcp?` (MCP servers the item sessions may use), `save?` (`scratch:<name>`), `workspace?` (`true`, or `scratch:<seed>`: a new directory per item it may write in, seeded from `<seed>/<n>/`) | The gathered result; without `gather`, each item's outcome as JSON, or saved to the scratch file with a summary back; each item's outcome (`done`, `failed`, `skipped`) and, with `workspace`, its directory |
| `vault_jobs` | `codemode` | `vaults?` | Jobs, conditions, last and next run |

Judgements and acceptance are deliberately not tools: the model must not judge
or approve its own work.

### Tool contract

- Parameters are TypeBox schemas; every parameter has a description.
- Each tool has a one-line `promptSnippet` and `promptGuidelines` that name the
  tool explicitly.
- Failures that carry information return `isError: true` with an explanation the
  model can act on.
- Large results are truncated with a note saying how to read the rest.
- Descriptions and schemas contain no values computed at runtime.

## Commands

Commands are typed by the person using Pi, so they may perform owner actions;
they act as the installation's `person`. Their arguments are read as the
CLI's are. What a command says is added to the session as a `pav:vault`
message, shown and not sent to the model on its own.

| Command | Does |
|---|---|
| `/vault status` | Pending proposals, checks, queued work |
| `/vault review <actor>` | Review a proposal and record the reviewed SHA |
| `/vault accept <actor>` | Accept the SHA you last reviewed if policy is satisfied |
| `/vault accept --adopt <sha>` | Show the delta from the accepted `main` and, once confirmed, accept it |
| `/vault contract <path>` | Effective contract for a path |
| `/vault jobs` | Jobs and their state |
| `/vault run <document>` | Run a job now |
| `/vault trace <id>` | Show a trace |
| `/vault doctor` | Health check |
| `/vault actor [name]` | Show whom the session writes as and its worktree in each vault, or write as `name` instead (see [Pi extension](components/extension.md#actor-and-budget)); a session command, not an operation, so it has no tool |
| `/vault install-cli` | Put the `vault` launcher on `PATH` (see [CLI](components/cli.md#installation-of-the-command)) |

## Hooks

| Hook | Use |
|---|---|
| `session_start`, `session_shutdown` | Start and release resources |
| `before_agent_start` | Vault catalog in the system prompt |
| `tool_call` | Write guard, session events |
| `tool_result` | Trace capture, taint, injected context |
| `turn_end`, `session_compact` | Budget accounting |

## Flags

| Flag | Use |
|---|---|
| `--vault-run <file>` | Headless run context written by the daemon: vault, job document, actor, agent model, trace (whose allotment is the budget), triggering event, web grants (see [Pi extension](components/extension.md#headless-sessions)) |
| `--vault-actor <name>` | Actor for an interactive session not started in an actor's worktree (default: the installation's `person`) |

## Events

Published on `pi.events`, namespaced `pav:v1:`.

| Channel | Payload |
|---|---|
| `pav:v1:ready` | Extension `version`, `capabilities` (the request methods) and the session's `trace`, after `session_start` |
| `pav:v1:event` | A session or Git event, as matched against conditions |
| `pav:v1:spawn` | Spawn requested, started, finished or stopped (`state`), with `trace`, `vault`, `document` and, when stopped, `reason`; `started` and `finished` come from the daemon, for the session's own tree |
| `pav:v1:request` / `pav:v1:reply:<id>` | Request `{ id, method, params }` and reply for `ping`, `search`, `contract`, `status`: `{ ok, status, data, text, notices }`, or `{ ok: false, error }`. Nothing that writes or acts as an owner is offered |

A change that breaks a payload creates a `pav:v2:` channel; `v1` is kept until
removed in a major release.
