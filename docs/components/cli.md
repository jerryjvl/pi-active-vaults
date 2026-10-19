# CLI — `vault`

Every vault operation from the command line, for people and for scripts outside
the system. Commands are generated from the core's catalogue of operations, so
they mirror the Pi extension's tools and commands; each command's options are
its operation's parameters (`vault <command> --help`).

## Conventions

- `vault <command> [vault] [args]`. The vault may also be given with
  `--vault`, or in a path as `<vault-id>:<path>`; it may be omitted when the
  current directory is inside one — its checkout, or an actor's worktree,
  which also makes that actor the current actor. Paths are relative to the
  current directory when it is inside the vault.
- `--json` on every command gives machine-readable output.
- Exit status: `0` success, `1` failure, `2` usage error, `3` refused — by
  policy (for example an unmet merge requirement) or by a guard.
- Works without the daemon. Commands that need it say so and exit `1`.
- Every command first reports any vault with an unaccepted change to `main`, on
  standard error, until it is adopted or discarded.

## Commands

### Vaults and installation

| Command | Does |
|---|---|
| `vault init <path> [--template <url\|name>[@ref]] [--id <id>] [--person <name>]` | Create a vault — empty (owned by the installation's `person`, every change needing checks and an owner) or from a template with fresh history — and register it. Its first commit is its accepted `main`. Installs its hooks and makes your worktree. With no config file yet, creates one (private) with `installation.person` from `--person`, by default the OS user |
| `vault template show <url\|name>[@ref]` | Check that a repository is a compatible template and summarise it |
| `vault add <path> [--person <name>]` | Register an existing vault in the installation, by the id its root contract declares; nothing in it is accepted until an owner adopts `main`. Installs the vault's hooks where none of the user's are in the way, and says which it left; creates the config file as `init` does |
| `vault list` | Registered vaults and their catalog entries, and where the installation's `person` works in each (their actor worktree, under the state directory unless the vault configures another) |
| `vault whoami` | This installation's name, for use as a vault's `executor` |
| `vault doctor [--fix]` | Check the installation and each vault (below). A problem exits `1`; warnings do not. `--fix` installs hooks where none of the user's is in the way, corrects permissions and, when no daemon runs, runs its start-up recovery |

`vault doctor` checks:

- config, Pi, Git, paths and permissions, and model endpoints' tokens (without calling them);
- hooks, including a `core.hooksPath` that bypasses them;
- the daemon service and the directories recorded for its `PATH`;
- forge settings, merge methods included where the forge shows them;
- a `local` vault with a remote, and merged proposals whose commits did not reach `main`;
- actor holds, including any whose holder cannot be told;
- a leftover Git lock in `main`'s worktree, and undelivered notifications;
- search that is keyword-only because no `policy` entry names the vault;
- jobs that cannot run (no budget, no permitted actor, or no `agent` model it may use), and an unset `budgets.daily-tokens`;
- models: requested names that are not configured (and the default that answers instead), names with the wrong role, defaults that documents need but are missing, models `policy` does not allow where they are asked for, and `policy` names that match no configured model.

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
| `vault status` | The installation `person`'s worktree in each vault (not over MCP), pending proposals, failing checks, queued work, jobs that cannot run for lack of a model, holds, merged proposals whose commits did not reach `main`, undelivered notifications |
| `vault review <actor>` | Commits, diff, checks and control-change flags; records the reviewed SHA |
| `vault accept <actor>` | Merge the SHA you last reviewed if the merge policy is satisfied |
| `vault accept --adopt <sha>` | Show failed checks and control changes in the delta from the accepted `main` first, to be acknowledged; then the delta, and accept once confirmed. Without a terminal, it shows them and exits `3`; `--acknowledge <digest> --yes` confirms what was shown |
| `vault sync [actor]` | Bring actor branches up to date with the accepted `main` — forward, or with a merge that the checks assess; in `forge` mode, fetch first |
| `vault propose <actor>` | In `forge` mode: push the actor branch and open or update its pull request |
| `vault commit -m <msg> [paths] [--actor <name>]` | Commit the actor's worktree as the current actor (else `--actor`, else the installation's `person`), with trailers, if every check passes |

### Work

| Command | Does |
|---|---|
| `vault jobs` | Jobs with their conditions, the model each asks for, last run, next run and pending items, and which cannot run |
| `vault run <document>` | Run a job now, outside its conditions |
| `vault trigger <name> [--payload <file>]` | Emit an external event |
| `vault script <name> [args]` | Run an approved script; its arguments, options included, pass through |
| `vault notify --to <alias> --subject <text>` | Send a notification (body on standard input); `vault notify test --to <alias>` checks the transport by delivering a test message at once, outside the outbox |
| `vault trace <id>` | Show a trace: its newest compact record per vault and its commits; full detail while logs are retained |

### Daemon

| Command | Does |
|---|---|
| `vault daemon install` | Write the platform's user-service definition, with the `PATH` where `node`, `pi` and `git` are now, and record it for `vault doctor` |
| `vault daemon start` / `stop` / `status` | Control the installed service; `status` asks the running daemon and exits `1` when there is none |
| `vault daemon run` | Run in the foreground until signalled; when another daemon already runs, it says so and exits `0` |
| `vault daemon print-unit` | Print the service definition, for declarative setups |
| `vault daemon … --headless` | macOS: the launchd daemon for a Mac nobody logs in to; `print-unit` prints it, and `install`, `start` and `stop` say what to run with `sudo`, since it is the system's |
| `vault mcp --profile <name>` | Serve one MCP profile over standard input/output, for local MCP clients |

## Installation of the command

Pi does not put package executables on `PATH`. The extension's `/vault
install-cli` command writes a small launcher to a user directory usually on
`PATH` (`~/.local/bin/vault` on Linux and macOS,
`%LOCALAPPDATA%\Microsoft\WindowsApps\vault.cmd` on Windows) and says if it is
not; it replaces only a launcher it wrote. It also names any other `vault` on `PATH` and says which one runs — the first on `PATH`, which is the launcher only if its directory comes first. `npx pi-active-vaults` also works.
