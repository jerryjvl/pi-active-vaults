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
| **Signer** | Optional: signs web grants, so jobs can fetch the URLs their owners reviewed, under a user of its own |
| **Core library** | The shared implementation behind them all |

## Requirements

- Linux, macOS or Windows
- Pi ≥ 1.3, with a model configured
- Node.js ≥ 22.18
- Git ≥ 2.38

## Getting started

**1. Install** from a checkout of this repository. The package is not on npm,
and `pi install git:…` does not work: the built files are not in Git, and
nothing builds at install time.

```sh
git clone https://github.com/jerryjvl/pi-active-vaults.git
cd pi-active-vaults
npm install && npm run build
pi install "$PWD"
```

Then, inside Pi, put the `vault` command on your `PATH` (it reports any other
`vault` command it finds there):

```
/vault install-cli
```

**2. Create a vault.** On first use this also creates the installation config,
with you as its person (your OS user name, or `--person <name>`), installs the
vault's Git hooks and makes your worktree:

```sh
vault init ~/vaults/notes
```

**3. Work in your worktree** — `vault list` shows where it is, and `vault workspace --open` opens all of yours in one editor window. Commit there,
then review and accept your own proposal into `main`:

```sh
cd <your worktree>
vault commit -m "First note"
vault review <you>
vault accept <you>
```

**4. Add an agent and a job.** In your worktree, name an agent in the root
contract (`vault.actors: [librarian]`) and add a job document:

```markdown
---
actor: librarian
budget: { tokens: 50000, ttl: 5m }
applies-when:
  - { on: timer, schedule: "0 7 * * *", effect: spawn }
---
Summarise yesterday's new notes in digests/<date>.md and commit it.
```

Both are control changes: commit, review and accept them like any other.

**5. Start the daemon**, which runs jobs while Pi is closed:

```sh
vault daemon install
vault daemon start
```

The agent's work arrives as a proposal from `librarian`; review and accept it
as in step 3.

**Check the setup** at any time with `vault doctor` (`--fix` repairs what it
can). Before relying on it, also:

- configure models — at least `agent` (background jobs) and `judgement` (merge
  judgements), each the strongest you have — and the `policy` that allows them
  ([Models](docs/concepts.md#models)); without `embed`, search is keyword-only;
- list the tools that do not taint a session in `taint.trusted-tools` — by
  default every tool does, so `when-tainted` merge rules always apply;
- give secrets as `!command` (a keyring lookup) rather than `${ENV}`: the
  daemon does not see your shell's environment;
- for vaults on several machines, or where agents must not be able to change
  accepted knowledge, use a forge ([Security setup](docs/security-setup.md)).

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
| [Signer](docs/components/signer.md) | Signed statements: web grants |
| [Notifications](docs/notifications.md) | The built-in email notification script |
| [MCP](docs/mcp.md) | The daemon's MCP server and its exposure limits |
| [Pi API surface](docs/api.md) | Tools, commands, hooks and events registered with Pi |
| [Pi conventions](docs/pi-conventions.md) | How the package fits Pi's framework |

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
`PAV_SMOKE_KEEP=1` to keep the temporary directories, which are otherwise
removed however the run ends.

## License

[MIT](LICENSE)
