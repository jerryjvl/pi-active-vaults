# Pi conventions

How the package fits Pi's framework. Written against Pi 1.3; check the docs
shipped with the installed Pi (`pi --version`) when an API is in doubt.

## Packaging

- One npm package with the `pi-package` keyword and a `pi` manifest listing the
  extension and skills.
- Pi's own packages (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`,
  `pi-tui`, `typebox`) are `peerDependencies` with range `"*"`. They are never
  bundled — a second copy breaks Pi's module mapping.
- No npm lifecycle scripts. Anything that changes the machine (the CLI launcher,
  the daemon service) is an explicit command.
- Pi loads each package with its own module root. Do not rely on sharing a module
  instance with another package.

## Extension lifecycle

- The extension factory registers tools, commands, flags and hooks, and nothing
  else. It starts no timers, watchers, sockets or processes — Pi sometimes loads
  extensions without starting a session.
- Long-lived resources start in `session_start` and are released in an
  idempotent `session_shutdown` handler.
- Anything that must outlive a session belongs in the daemon.

## Tools

- Register with `pi.registerTool` and TypeBox schemas.
- `promptGuidelines` bullets name the tool explicitly; Pi appends them flat, so
  "this tool" is ambiguous.
- Choose exposure deliberately: `direct` for the few tools used constantly,
  `codemode` for the rest. Each `direct` tool costs context in every request.
- Declare `outputSchema` and return `structuredContent` when the result is data,
  so scripts and other extensions get data rather than text.
- Report recoverable failures with `isError: true`, not by throwing.
- Tools that orchestrate others call them with `ctx.executeTool`, so nested
  calls pass through every package's hooks.

## Hooks

- Handlers run in load order. Return values follow each event's declared result
  type; check it before relying on an effect.
- A `tool_call` handler that throws blocks the call. Write guards rely on this
  and must still throw only deliberately.
- Context changes are appended. Never rewrite earlier messages, system prompt
  sections or tool declarations mid-session.

## Prompt-cache stability

- Tool lists, catalog entries and injected documents are ordered
  deterministically.
- Descriptions and system-prompt sections contain no timestamps, counts or other
  changing values.
- The vault catalog is fixed at session start; changes take effect in the next
  session.

## Trust

- Respect Pi's project trust: project-level configuration from an untrusted
  directory is ignored.
- Vault scripts and jobs are trusted only from the accepted `main`; a branch's
  or an unaccepted commit's versions never run.

## Inter-package conventions

- Events on `pi.events` are namespaced and versioned (`pav:v1:…`).
- Any service shared with other packages is published on `globalThis` under a
  versioned `Symbol.for("pi-active-vaults.<service>.v1")` key, because module
  instances are not shared.
- Detect other packages at runtime (`pi.getAllTools()`, a ping on their event
  channel). Never require them.

## Headless runs

- The daemon runs sessions as `pi --mode rpc` and passes run context with
  `--vault-run`.
- Sessions that branch from an interactive session use `pi --mode rpc --fork
  <session>`; Pi forks from user messages.
