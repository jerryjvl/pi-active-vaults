# Security model

What the package guarantees about unreviewed changes, and where those guarantees
are enforced.

## Starting assumption

A vault is a plain Git repository on a machine. **Any process running as the
same operating-system user can change anything in it** — files, branches,
`main`, hooks, configuration, and the package's own state. Agents with a shell
are such processes.

So the package makes two different promises:

| Setup | Promise |
|---|---|
| **Local** (plain Git) | Unexpected changes to `main` are **noticed** and never run as code or instructions until an owner accepts them. This protects against accidents and confused agents, not against a process deliberately working around it. |
| **Forge** (Gitea, GitHub, GitLab) | Nothing reaches the shared vault's `main` without an owner's approval — **enforced by the forge**, independent of any local machine. This is the guarantee to rely on when it matters. |

## The accepted `main`

Each vault has an **accepted `main`**: the commit the owner last accepted.

| Mode | Accepted `main` |
|---|---|
| `local` | The commit `vault accept` last produced or adopted, recorded in the state database |
| `forge` | The forge's `main` as last fetched — protected by the forge |

**Everything executable or instructional is resolved from the accepted `main`**,
never from the current tip of `main`, a branch or a working tree:

- vault scripts, checks and job documents;
- contracts and `applies-when` conditions;
- Git events for triggers (derived up to the accepted `main`);
- the search index (built up to the accepted `main`);
- the `web` blocks web grants are signed from, which the signer reads itself
  from the forge's `main` — or, marked `local: true`, a local clone's.

A commit on `main` that the owner has not accepted runs nothing and triggers
nothing.

## Unexpected changes

When the tip of `main` differs from the accepted `main` — new commits, a reset,
a rewrite — the vault has an **unaccepted change**:

- **Every command reports it.** Each `vault` CLI command, each Pi session using
  the vault, and each MCP response for the vault carries a notice naming the
  vault and the unaccepted commit, until it is resolved.
- **Automation pauses for that vault.** Triggers, spawns and script runs stop —
  checks too, so commits wait; reading, search, review and interactive work
  continue.
- **The owner is notified once** through `builtin:notify`, when a daemon is
  running.

It is resolved only by an explicit owner act:

| Resolution | Command |
|---|---|
| Accept the change | `vault accept --adopt <sha>` first shows any failed checks and control changes, which must be acknowledged; then the commits and diff from the accepted `main` to `<sha>`, flagging any rewritten history; and asks for confirmation before recording `<sha>` as accepted |
| Discard it | Reset `main` to the accepted `main` with Git, then run any command to confirm |

In `forge` mode, a local `main` that differs from the fetched forge `main` is
reported the same way; it is resolved by syncing with the forge, never by
adopting locally.

## Safeguards

| Safeguard | Mode | Protects against |
|---|---|---|
| Executable content only from the accepted `main` | Both | A stray commit on `main` running as code or instructions |
| Notice on every command until adopted | Both | Unexpected changes going unnoticed |
| Automation pauses on unaccepted changes | Both | Triggers acting on unreviewed state |
| Pre-push hook refusing pushes of `main` | Both | Accidental pushes of unreviewed work |
| The package never pushes `main`, and forces a push only to replace an actor branch that is exactly the head the forge reported merged | Forge | The package itself bypassing review, or overwriting work in the forge |
| Bot credential that is not an owner | Forge | An executor approving its own proposals |
| Protected `main` with required owner approval | Forge | Anything reaching the shared `main` unreviewed — even from a compromised machine |
| Merge commits or fast-forwards only, and each merge checked for the proposal's commits | Forge | Attestations and trace notes left attached to commits `main` does not contain |
| Content is data | Both | Text in documents, pages or tool results acting as instructions |
| Fan-out items can look but not write — except, when the fan-out asks for it, files in a new scratch directory of their own, checked at every write — reach only the MCP servers named for them from the person's own Pi configuration, and taint the session that fanned out | Both | A page read during research changing the vault directly, or untrusted content entering a proposal unmarked |
| Models only as `policy` allows, background jobs included | Both | A vault's content reaching a model its installation has not agreed to |
| Web access beyond the broker's default rules only as a reviewed job's `web` block allows, in a grant signed per run by a [signer](components/signer.md) whose key the daemon's user cannot read | Forge; local with `local: true` | A model or script sending vault content to a site the owner never named |

The Git hooks only speed things up and guard against accidents. Every safeguard
is checked by the action itself, and the daemon also polls each minute. A
repository that skips the hooks (for example through `core.hooksPath`) reacts up
to a minute later and loses the pre-push guard; `vault doctor` reports it.

## What is not guaranteed

- **A judgement is not proof against manipulation.** Decision models judge
  whatever content says, including text planted to steer them; weaker ones are
  easily swayed. Use the strongest judgement model for safety questions, and
  keep `owner` among the requirements for tainted proposals.
- **Locally, a deliberate same-user process can defeat the safeguards** — for
  example by editing the state database. Local mode is about accidents. Use a
  forge where a misbehaving agent must not be able to change accepted knowledge.
- **Local mode is for one clone.** The accepted `main` is recorded per machine,
  so a second clone sees the first one's accepts as unaccepted changes. Use a
  forge for a vault on several machines.
- **A process with the owner's forge credentials can do anything the owner
  can.** Keep owner credentials off executor machines.
- **The forge enforces what it is configured to.** A protection left out of
  the forge's settings is not supplied by the package (see [Security
  setup](security-setup.md)).
- **An open web entry lets anything reach its destination.** That includes
  whoever runs the subdomains a wildcard covers, the sites its redirects lead to
  unless the broker checks each hop, and the DNS provider that sees
  caller-chosen host labels. An open entry is the owner's decision to trust a
  site.
- **A signer reaches only as far as its user is kept apart.** Any process of the
  daemon's user can ask the signer for a reviewed job's grant, and so can use up
  a run's one live grant; it can never widen one. For a vault marked
  `local: true`, the signer trusts a `main` that a process of that clone's
  user can change.
- **Local data can be destroyed.** The forge, or another backup, is the recovery
  path.

## Requirements on the implementation

- The accepted `main` is read and written only by the core's `integrity` module;
  every component asks it before acting.
- Every propagating action — trigger, spawn, script run, index update, push —
  checks for an unaccepted change first, and refuses if there is one.
- Every user-facing surface (CLI, Pi, MCP) shows the unaccepted-change notice.
- Only the signer holds a signing key, and it runs as a user of its own. Each
  kind of statement it makes derives what it states from the signer's own
  fetch of a vault's `main`, never from the request. No key or secret command
  output appears in a log, trace, prompt or error.
- Each safeguard has a test demonstrating that its bypass is noticed or refused.
