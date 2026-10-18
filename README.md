# pi-active-vaults

A [Pi](https://pi.dev) package for **active knowledge vaults**: Git repositories
of Markdown documents that agents maintain, extend and act on — always under the
review of the vault's owners.

A vault holds knowledge *and* the instructions that keep it alive: jobs that run
on a schedule or when something changes, policies for each part of the tree, and
approved scripts for anything that must be done exactly. Agents propose changes
on their own branches; owners decide what reaches `main`.

## What it provides

| Component | Role |
|---|---|
| **Pi extension** | Vault tools and guards inside interactive Pi sessions |
| **`vault` CLI** | Every vault operation from the command line |
| **Daemon** | Timers, change monitoring, background jobs, forge sync and an MCP server, without Pi open |
| **Core library** | The shared implementation behind all three |

## Status

Pre-release. The design is complete; implementation is in progress.

## Documentation

| Document | Covers |
|---|---|
| [Principles](docs/principles.md) | The rules every part of the design follows |
| [Security model](docs/security.md) | Guarantees against unreviewed changes, and where they are enforced |
| [Security setup](docs/security-setup.md) | Recommended setup for local and forge vaults |
| [Concepts](docs/concepts.md) | The core concepts and the file formats that express them |
| [Architecture](docs/architecture.md) | Components, data locations, runtime flows |
| [Core library](docs/components/core.md) | Modules and responsibilities |
| [CLI](docs/components/cli.md) | Commands |
| [Pi extension](docs/components/extension.md) | Session behaviour |
| [Daemon](docs/components/daemon.md) | Background operation |
| [Notifications](docs/notifications.md) | The built-in email notification script |
| [MCP](docs/mcp.md) | The daemon's MCP server and its exposure limits |
| [Pi API surface](docs/api.md) | Tools, commands, hooks and events registered with Pi |
| [Pi conventions](docs/pi-conventions.md) | How the package fits Pi's framework |

## Requirements

- Linux, macOS or Windows
- Pi ≥ 1.3
- Node.js ≥ 22.18
- Git ≥ 2.36

## Development

`npm test` runs the test suite (no network, a fake `pi`), `npm run check` the
type check. `npm run smoke` is an opt-in check against a real model, outside
`npm test`: it builds the package, then runs a job headless through the
daemon with the Pi development dependency and the built extension, and a
second job forked from the first run's session, in temporary directories. It
reports each run's outcome, commit, trailers and trace record.

```sh
PAV_SMOKE_BASE_URL=http://localhost:8080/v1 PAV_SMOKE_MODEL=my-model npm run smoke
```

Optional: `PAV_SMOKE_API` (Pi's API type, default `openai-completions`),
`PAV_SMOKE_API_KEY`, `PAV_SMOKE_TIMEOUT` (seconds, default 600) and
`PAV_SMOKE_KEEP=1` to keep the temporary directories.
