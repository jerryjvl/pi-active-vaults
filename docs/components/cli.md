# CLI — `vault`

Every vault operation from the command line, for people and for scripts outside
the system. Commands mirror the Pi extension's tools and commands.

## Conventions

- `vault <command> [vault] [args]`. The vault may be omitted when the current
  directory is inside one.
- `--json` on every reading command gives machine-readable output.
- Exit status: `0` success, `1` failure, `2` refused by policy (for example an
  unmet merge requirement).
- Works without the daemon. Commands that need it say so and exit `1`.
- Every command first reports any vault with an unaccepted change to `main`, on
  standard error, until it is adopted or discarded.

## Commands

### Vaults and installation

| Command | Does |
|---|---|
| `vault init <path> [--template <url\|name>[@ref]] [--id <id>]` | Create a vault: empty, or from a template with fresh history; registers it |
| `vault template show <url\|name>[@ref]` | Check that a repository is a compatible template and summarise it |
| `vault add <path>` | Register an existing vault in the installation |
| `vault list` | Registered vaults and their catalog entries |
| `vault whoami` | This installation's name, for use as a vault's `executor` |
| `vault doctor [--fix]` | Check config, Pi, Git, model endpoints, hooks, daemon service, paths and forge settings; `--fix` installs hooks and corrects permissions |

### Knowledge

| Command | Does |
|---|---|
| `vault search <query>` | Search registered vaults (`--vault`, `--scope <glob>`) |
| `vault read <path>` | Print a document, with freshness against the accepted `main` |
| `vault contract <path>` | Effective contract for a path, with the origin of each key |
| `vault reindex [vault]` | Rebuild the search index |

### Proposals

| Command | Does |
|---|---|
| `vault status` | Pending proposals, failing checks, queued work |
| `vault review <actor>` | Commits, diff, checks and control-change flags; records the reviewed SHA |
| `vault accept <actor>` | Merge the reviewed SHA if the merge policy is satisfied |
| `vault accept --adopt <sha>` | Show the delta from the accepted `main` to `<sha>` and, once confirmed, accept it |
| `vault sync [actor]` | Bring actor branches up to date with `main`; in `forge` mode, fetch first |
| `vault propose <actor>` | In `forge` mode: push the actor branch and open or update its pull request |
| `vault commit -m <msg>` | Commit as the current actor, with checks and trailers |

### Work

| Command | Does |
|---|---|
| `vault jobs` | Jobs with their conditions, last run, next run and pending items |
| `vault run <document>` | Run a job now, outside its conditions |
| `vault trigger <name> [--payload <file>]` | Emit an external event |
| `vault script <name> [args]` | Run an approved script |
| `vault notify --to <alias> --subject <text>` | Send a notification (body on standard input); `vault notify test` checks the transport |
| `vault trace <id>` | Show a trace; full detail while logs are retained |

### Daemon

| Command | Does |
|---|---|
| `vault daemon install` | Write the platform's user-service definition |
| `vault daemon start` / `stop` / `status` | Control the installed service |
| `vault daemon run` | Run in the foreground |
| `vault daemon print-unit` | Print the service definition, for declarative setups |
| `vault mcp --profile <name>` | Serve one MCP profile over standard input/output, for local MCP clients |

## Installation of the command

Pi does not put package executables on `PATH`. The extension's `/vault
install-cli` command writes a small launcher to a user directory on `PATH`
(`~/.local/bin/vault` on Linux and macOS, `vault.cmd` under `%LOCALAPPDATA%` on
Windows); `npx pi-active-vaults` also works.
