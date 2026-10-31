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
- Whatever must be resolved by hand — an unaccepted change, a conflict,
  uncommitted changes, a merge in progress, a worktree on the wrong branch —
  is reported with the commands that resolve it, each set starting with the
  `cd` to the directory it is for: the vault's clone or an actor's worktree,
  as they are on this machine.

## Commands

### Vaults and installation

| Command | Does |
|---|---|
| `vault init <path> [--template <url\|name>[@ref]] [--id <id>] [--person <name>]` | Create a vault — empty (owned by the installation's `person`, every change needing checks and an owner) or from a template with fresh history — and register it. Its first commit is its accepted `main`. Installs its hooks and makes your worktree. With no config file yet, creates one (private) with `installation.person` from `--person`, by default the OS user |
| `vault template show <url\|name>[@ref]` | Check that a repository is a compatible template and summarise it |
| `vault add <path> [--person <name>]` | Register an existing vault in the installation, by the id its root contract declares; nothing in it is accepted until an owner adopts `main`. Installs the vault's hooks where none of the user's are in the way, and says which it left; creates the config file as `init` does |
| `vault list` | Registered vaults and their catalog entries, and where the installation's `person` works in each (their actor worktree, under the state directory unless the vault configures another) |
| `vault whoami` | This installation's name, for use as a vault's `executor` |
| `vault workspace [--open]` | Write an editor workspace (VS Code's format) with your worktree in each vault you own or write as, one folder per vault named by its id, making missing worktrees; `--open` first brings those worktrees up to date with the accepted main (one with uncommitted changes is left as it is, and said so), then opens it with `code` |
| `vault doctor [--fix]` | Check the installation and each vault (below). A problem exits `1`; warnings do not. `--fix` installs hooks where none of the user's is in the way, corrects permissions and, when no daemon runs, runs its start-up recovery |

`vault doctor` checks:

- config, Pi, Git, paths and permissions, and model endpoints' tokens (without calling them);
- hooks, including a `core.hooksPath` that bypasses them;
- the daemon service and the directories recorded for its `PATH`;
- forge settings, merge methods included where the forge shows them;
- a `local` vault with a remote, and merged proposals whose commits did not reach `main`;
- actor holds, including any whose holder cannot be told;
- a leftover Git lock in `main`'s worktree, and undelivered notifications;
- each notification spool: missing, not owned by this user, open to others, not writable or listable by its group, a group this user is not in; and messages it rejected or that have waited more than an hour;
- search that is keyword-only because no `policy` entry names the vault;
- where each vault's jobs run, as far as this installation can tell: here, or on the executor its contract names; a warning when it has jobs but names no executor and `host` is not true here, since they then run only where some other installation hosts it, if any;
- jobs that cannot run (no budget, no permitted actor, no `agent` model it may use, or a `web` block that is not valid), and an unset `budgets.daily-tokens`;
- web grants: the key of a signer this installation runs; whether the signer in `web-grants` answers; and each job here whose runs would get no grant (no `web-grants`, or a wildcard too open for the signer's minimum);
- models: requested names that are not configured (and the default that answers instead), names with the wrong role, defaults that documents need but are missing, models `policy` does not allow where they are asked for, and `policy` names that match no configured model.

### Knowledge

| Command | Does |
|---|---|
| `vault search <query>` | Search registered vaults (`--vault`, `--scope <glob>`) |
| `vault read <path>` | Print a document, with freshness against the accepted `main` |
| `vault contract <path>` | Effective contract for a path, with the origin of each key |
| `vault reindex [vault]` | Bring the search index up to the accepted `main` now (the daemon also does so on its next tick after `main` moves). An update that runs longer than a few seconds says how far it has got on standard error — documents read, then chunks embedded — every few seconds and at the end of each phase |

### Proposals

| Command | Does |
|---|---|
| `vault status` | The installation `person`'s worktree in each vault (not over MCP), pending proposals, failing checks, queued work, jobs that cannot run for lack of a model, holds, merged proposals whose commits did not reach `main`, undelivered notifications |
| `vault review <actor>` | Judges what the proposal still needs judged; shows commits, diff, checks, judgements and control-change flags; records the reviewed SHA |
| `vault accept <actor>` | Merge the SHA you last reviewed if the merge policy is satisfied |
| `vault accept --adopt <sha>` | Show failed checks and control changes in the delta from the accepted `main` first, to be acknowledged; then the delta, and accept once confirmed. Without a terminal, it shows them and exits `3`; `--acknowledge <digest> --yes` confirms what was shown |
| `vault sync [actor]` | Bring actor branches up to date with the accepted `main` — forward, or with a merge that the checks assess; in `forge` mode, fetch first, and leave an owner's branch that has work not yet in `main` as it is (it is an open proposal only `vault propose` pushes, so a merge here would leave a head the owner never approved; the forge merges it as it stands); a `local` vault that names a remote is then backed up there (or told how to add the remote). A branch whose merge would conflict is left as it was, and the output says which files and how to resolve it: merge the accepted `main` by hand in its worktree, then `vault commit` |
| `vault propose <actor>` | In `forge` mode: judge what the proposal still needs, push the actor branch, open or update its pull request, and ask the forge to merge it once approved — saying whether it will, or that it must be merged by hand and why (security-setup.md "Merging once approved") |
| `vault commit -m <msg> [paths] [--actor <name>]` | Commit the actor's worktree as the current actor (else `--actor`, else the installation's `person`), with trailers, if every check passes; then judges what the proposal's merge rules need. With a merge in progress (one resolved by hand) the commit is that merge, with the merged commit as a further parent: committed whole (no paths), and refused while any file is still unresolved |

### Work

| Command | Does |
|---|---|
| `vault jobs` | Jobs with their conditions, the model each asks for, its `web` block's requests and open entries, last run, next run and pending items, and which cannot run |
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

### Signer

Run as the [signer's](signer.md) own user.

| Command | Does |
|---|---|
| `vault signer key <file>` | Make a new signing key in a new file that only the user can read, never writing over one; print its public key as a JWK for verifiers |
| `vault signer run` | Run the signer in the foreground until signalled; it does not start without a `signer` section and a key it can use |
| `vault signer status` | Ask the signer whether it answers, and with which key: the one in `web-grants.signer`, else this user's own; exit `1` when none answers |

## Installation of the command

Pi does not put package executables on `PATH`. The extension's `/vault
install-cli` command writes a small launcher to a user directory usually on
`PATH` (`~/.local/bin/vault` on Linux and macOS,
`%LOCALAPPDATA%\Microsoft\WindowsApps\vault.cmd` on Windows) and says if it is
not; it replaces only a launcher it wrote. It also names any other `vault` on `PATH` and says which one runs — the first on `PATH`, which is the launcher only if its directory comes first. `npx pi-active-vaults` also works.
