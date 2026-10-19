# Concepts

Seven concepts make up the core. Everything else is built from them.

| Concept | Answers |
|---|---|
| **Document** | What knowledge and instructions exist |
| **Session tree** | How work runs |
| **Script** | What exact actions exist |
| **Attestation and merge policy** | What may reach `main` |
| **Actor** | Whose proposals, in which review lane |
| **Trace** | Why something happened |
| **Installation** | How vaults compose on one machine |

## Document

A Markdown file with optional YAML frontmatter. Standard keys:

| Key | Meaning |
|---|---|
| `labels` | Terms from the vault's vocabulary |
| `applies-when` | Conditions under which the document is injected into a session or spawns work |
| `budget` | `{ tokens, ttl }` — required on any document that can spawn work; `ttl` in whole seconds, minutes or hours (`90s`, `30m`, `2h`) |
| `actor` | The actor its spawned work writes as: one of the vault's `actors`, never an owner; else the nearest contract's `actor`. A spawning document without one does not run (`vault jobs` and `vault doctor` report it) |
| `model` | The `agent` model its spawned work runs on, by name (see [Models](#models)); else the nearest contract's `model`; else the default `agent`. A `model` that is not a name stops the job from running (`vault jobs` and `vault doctor` report it) |
| `provenance` | Written by the runtime: trace ID and a compact causal path |

Any other key is the vault's own.

### `applies-when`

A list of conditions. Each names an event, filters on it, and has an effect.

```yaml
applies-when:
  - on: merged
    paths: ["topics/cars/**"]
    change: [created, modified]
    effect: spawn
  - on: timer
    schedule: "30 6 * * *"
    missed: run-once
    effect: spawn
  - on: session.path
    paths: ["projects/infrastructure/**"]
    effect: inject
```

| Field | Values |
|---|---|
| `on` | `timer`, `committed`, `merged`, `session.start`, `session.tool`, `session.path`, `external` |
| `effect` | `inject` — add the document to the current session's context; `spawn` — start a session that runs the document |
| `schedule`, `missed` | Timer only: cron expression; `run-once` (default) or `skip` for runs missed while nothing was running |
| `paths`, `change` | Path globs and change kinds (`created`, `modified`, `deleted`, `renamed`) |
| `labels` | Match if the changed document carries any of these labels |
| `actor` | Git events: match if the changes were made by one of these actors (their `Vault-Actor` trailer) |
| `tools`, `model` | Session events: tool names; model names — matching a session whose model is one these names map to on this installation (the model actually used, not one requested) |
| `name` | External events: the event name given to `vault trigger` |
| `script` | Spawn only: an approved script that receives the event as JSON on standard input; the spawn happens only if it exits `0` |
| `context` | Spawn only: `session-preferred` (default), `bare`, `session-required` |

The fields of a condition must all match; a document applies when any of its
conditions does. There is deliberately no richer expression language:

- **Keep filters as narrow as the job allows.** Every match that spawns starts a
  session, and even one that decides to do nothing spends a model turn.
- **The job's own instructions refine the match.** A spawned session receives
  the triggering event as structured data — kind, commits, changed paths with
  their change kinds, labels and actor — so a job can say "do nothing unless at
  least three files were modified". A run that ends normally without changes is
  recorded as `no-change`.
- **`script` is the precise escape hatch.** It runs only after every other field
  has matched and can only narrow the match, so what a condition can match is
  still known from its other fields.

Conditions never name other vaults. Events from another vault reach a document
only when the installation subscribes this vault to that one; labels are matched
across vaults only where the installation declares them equivalent.

Events come from two sources:

- **Git events** — commits and merges, derived from Git history. Uncommitted
  edits are not events.
- **Session events** — what a Pi session does: tools used, paths touched, the
  model it started with.

A spawned session **branches** from the point that triggered it when that
session is available, inheriting its context; otherwise it starts fresh with the
document and the compact trace.

### Contracts

A file named `_contract.md` is a document that applies to its directory and
everything below it. Its frontmatter is enforced; its prose is injected into any
session that reads or edits a path it governs.

A directory's **effective contract** merges every `_contract.md` from the vault
root down. Each key has a merge strategy:

| Strategy | Meaning |
|---|---|
| `nearest` | The deepest value wins |
| `merge` | Maps merge key by key |
| `list-ops` | `[+x]` adds, `[-x]` removes, a plain list replaces; a mapping item is written `+: {…}` or `-: {…}`, and removes only an equal item |
| `tighten-only` | Deeper contracts may add requirements, never remove them |
| `locked` | Root contract only |

Contract keys:

| Key | Strategy | Meaning |
|---|---|---|
| `vault` | `locked` | Vault identity: `id`, `purpose`, `audience`, `owners`, `actors`; optionally `executor`, `review` and `from-template` |
| `template` | `locked` | Present only in a template repository: `name`, `version`, `summary` (see Templates) |
| `merge` | `tighten-only` | Merge rules (below) |
| `index` | `nearest` | `default`, `opt-in` or `none` — whether search includes the subtree (`opt-in`: only within a search's explicit scope) |
| `naming` | `nearest` | Filename pattern for new documents, e.g. `"{topic}-{date}.md"` |
| `axes` | `merge` | Judgement questions (below) |
| `applies-when` | `list-ops` | Conditions that apply to every document in the subtree |
| `actor` | `nearest` | The actor of jobs in the subtree that name none themselves |
| `model` | `nearest` | The `agent` model of jobs in the subtree that name none themselves |

Any other key is the vault's own and merges `nearest`. Paths in contracts and
conditions are relative to the vault root.

The root contract also identifies the vault:

```yaml
---
vault:
  id: home-knowledge
  purpose:
    summary: House hardware, network and how things connect.
    use-for: [device questions, network topology]
    not-for: [personal health, work]
  audience: household
  owners: [alice, bob]
  actors: [librarian, gardener]
  executor: alice@homeserver   # optional: the only installation that runs background jobs
merge:
  - paths: ["**"]
    require: [checks, owner]
---
```

### Merge policy

`merge` is a list of rules. Every changed path must satisfy the requirements of
**every** rule whose globs match it, so deeper or more specific rules can only
add requirements.

| Requirement | Satisfied by |
|---|---|
| `checks` | Every blocking check passed for the exact commit |
| `owner` | An owner approved the exact commit |
| `judgement:<axis>` | The named axis was judged passing for the path's current content; a deleted path cannot be judged and needs `owner` instead |

A rule may add `when-tainted: [...]` — extra requirements when the proposal came
from a session that read untrusted content. A proposal is tainted when any of
its commits carries a `Vault-Tainted` trailer, or was not made by the package
(has no `Vault-Trace`).

**Control changes always need an owner.** Whatever the contracts say, a change
to any `_contract.md`, anything under `.vault/`, or the `applies-when`,
`budget`, `actor` or `model` of any document requires `owner`. Agents may propose such
changes; review flags them.

### Judgement axes

`axes` declares the questions a judgement asks of a document, each with the
answer that makes it pass:

```yaml
axes:
  evidence:
    type: choice
    instructions: What backs the main claims?
    options:
      primary: Cites data or a first-hand source
      secondary: Reports others' claims
      opinion: Argument without sources
    pass-when: { choices: [primary, secondary], probability: 0.7 }
  relevance:
    type: score
    instructions: How relevant is this to the vault's purpose?
    levels: [unrelated, tangential, relevant, core]   # lowest first
    pass-when: { level: relevant }
  personal-data:
    type: bool
    model: judgement            # optional: a judgement model by name; default `judgement`
    instructions: Does this contain personal health or financial data?
    true: Contains such data
    false: Contains none
    pass-when: { value: false, probability: 0.9 }
```

| Type | `pass-when` | Passes when |
|---|---|---|
| `bool` | `value` (default `true`), `probability` | The probability of `value` is at least `probability` |
| `choice` | `choices`, `probability` | The listed options' combined probability is at least `probability` |
| `score` | `level`, optional `confidence` | The expected level is at least `level`, and the confidence at least `confidence` |

Each axis is judged and recorded on its own, so a rule requires exactly the
axes it names (`require: [judgement:evidence, judgement:relevance]`). An axis
that cannot be judged — no permitted model, an error, content too large for the
model — never passes: nothing is recorded, and its requirement stays unmet.
Axes that have a model are still judged: one that has none is reported
unjudged, and the judgement does not pass.

**When judgements run:** a commit, once its blocking checks pass, judges the
documents its proposal's merge rules still need judged; `vault review`,
`vault propose` and the daemon's forge sync judge whatever is still missing
for the current content. A judgement already recorded for the same content,
model and axis version is reused. One that cannot be made never fails the
commit or the review — it only leaves its requirement unmet. Accepting never
asks a model: it evaluates what is recorded.

An axis may name the judgement model that answers it (`model`); without one,
the default `judgement` does. Naming a faster model is an optimisation for
routine questions. Questions that guard against manipulation or sensitive data
should use the default, which should be the strongest judgement model
available: decision models judge whatever the content says, including text
planted to steer them, and stronger ones resist it far better. An axis's
`pass-when` is tuned for the model that answers it; if a named model is not
configured and the default answers instead, `vault doctor` reports it.

## Session tree

Sessions start from a trigger and branch as they spawn work. Budgets flow down:

- A spawned session receives the smaller of its document's budget and its
  allotment from the root's **cascade pool**: the pool's remaining tokens ×
  `budgets.depth-decay` (default 0.5) per level of depth × the trigger's
  relevance score (1 when it has none). An allotment is held from the pool
  until its session ends; then only what it used is. Without a configured
  `budgets.cascade-pool`, the documents' budgets, max-depth and the daily
  ceiling bound the tree.
- `budgets.daily-tokens` caps every allotment and all work on the
  installation per UTC day.
- Tokens are counted as work: prompt and generated tokens of every request,
  including compaction, excluding cached-prefix reads.
- `ttl` is run time; queue time has its own limit.
- No document fires twice in one tree. `budgets.max-depth` (default 4) backs
  this up.
- **Work a run commits stays in its tree.** An event from a commit carrying a
  run's `Vault-Trace` continues that run's tree — also after a merge, rebase or
  amend, which keep the trailer — so a job whose own commits match its
  condition does not fire again. Commits without the trailer, such as a
  person's edits, start new trees. A merge's changes are attributed to the
  commits that made them, so one merge can continue several trees.

**Fan-out and gather** is the built-in multi-session shape: a list of items, an
instruction for each, and optionally an instruction to combine the results. The
list can come from anything the session can do. Each item is a session of its
own, on the same model, that can look but not write: Pi's read-only file tools,
`vault_read`, `vault_search`, and the tools of the MCP servers the fan-out names
from the person's own Pi configuration (a web search, say). Items run as many
at a time as the agent model's `parallel` allows. The session that fanned out
writes what comes back. An item that fails is reported as failed, never handed
to the gather; without a gather instruction each item's outcome comes back as
it is. The items' work is the session's: their tool calls are in its trace, a
tool that taints taints the session, and their tokens count against its
budget.

Ordering between jobs comes from events, not priorities: a job that should run
after another reacts to that job's merged work (`on: merged`, `actor: …`).

## Script

An executable in `.vault/scripts/`, run only from the accepted `main` (see
[Security model](security.md)). It starts with
a header comment:

```
# name: due-topics
# summary: Digest topics due today, one per line
# args: [--date YYYY-MM-DD]
# output: lines
# net: no
```

Scripts take arguments, print results, exit non-zero on failure, and never
prompt. Header lines are comments (`#` or `//`); `name` and `summary` are
required, `name` is the file name without its extension, and `net` defaults to
`yes`. Files in subdirectories, and hidden files, are support files, not
scripts. A script runs with the interpreter in its `#!` line; on Windows the
package runs it through that interpreter, or through Git for Windows' `sh` for
shell scripts. A script declaring `net: no` runs without network access where
the platform allows it.

**Built-in scripts** ship with the package under the `builtin:` prefix and are
available to every vault. A vault cannot replace or shadow them:

- `builtin:notify` sends a notification — see [Notifications](notifications.md).
- `builtin:judge` lets a job ask the judgement models typed questions about
  content it supplies — is this item relevant to the topic, new against the
  facts, an injection attempt? It takes `{ state, questions }` as JSON on
  standard input (or `--file`), with questions in the axis format and
  `pass-when` optional, and prints each answer with the model that gave it.
  Each question is answered by the model it names, else the default, and only
  by a model the policy allows for the vault. **The answers are advisory:**
  nothing is recorded, so they never become attestations or satisfy a merge
  requirement — a model still never approves its own work.

**Checks** are scripts in `.vault/checks/` that assess a proposal and produce an
attestation. **Judgements** are checks that call a judgement-role model.

Every check on the accepted `main` is blocking. A check runs against one exact
commit: its working directory is a fresh export of that commit's files, and
its standard input is the proposal as JSON — `vault`, `commit`, `base` (where
the commit's history meets the accepted `main`), `actor`, and `changes`
(`change`, `path`, `oldPath`). Exit `0` is `pass` and any other exit
`fail`; a check that times out, cannot run or is not a valid check is
`error`. The first line of its output is the evidence. A commit is made only
when every check passes it; its verdicts are then recorded.

## Attestation and merge policy

An attestation records a verdict about an exact subject:

| Field | Meaning |
|---|---|
| `kind` | `check`, `judgement` or `approval` |
| `name` | Which check, judgement axis or approver |
| `subject` | Commit SHA, or the blob SHA of judged content |
| `result` | `pass`, `fail`, or a named outcome |
| `by` | Script, model, or person |
| `version` | The check's blob SHA or the judged axis's version; absent for approvals |
| `evidence` | Short supporting detail |
| `at` | When it was recorded (UTC, ISO 8601) |

Attestations are stored as Git notes on `refs/notes/vault/attestations`, so they
travel with the repository: one JSON object per line in the note on the subject.
When notes written on different machines meet, they are merged line by line
(Git's `cat_sort_uniq` strategy), so every record from both sides is kept. For
each kind and name the latest record by `at` counts, and of equally late ones,
a non-`pass`. Accepting a proposal evaluates the merge policy against the
attestations for the exact commit under review; a check counts only at its
version on the accepted `main`, and a judgement only for the current content
and axes.

## Actor

A named writer — an agent role or a person — with its own branch (default
`actor/<name>`) and worktree (`<worktrees>/<name>`, from the installation
config). An actor is one of the root contract's `actors` or `owners`. Many jobs
may write into one actor's branch; each actor's branch is one review lane.

**One writer at a time.** At most one session writes as an actor at once. The
daemon runs one job per actor at a time and queues the rest. A Pi session
started as a busy actor is told which session holds it, and can wait or choose
another actor. A session holds its actor through a record of its process, so a
session that has ended — however it ended — holds nothing, and there is
nothing to unlock.

A **proposal** is an actor's branch ahead of `main`. The vault's root contract
chooses how proposals are reviewed (`vault.review`):

| Mode | Proposal | Approval | Merge |
|---|---|---|---|
| `local` (default) | Actor branch in the local repository | `vault accept` by an owner (the installation's `person` must be in `vault.owners`) | `vault accept`, of the SHA that owner reviewed |
| `forge` | Actor branch pushed to the vault's remote, shown as a pull request | Owner review in the forge (Gitea, GitHub, GitLab) | The forge, gated by branch protection |

`local` mode is for a vault with **one clone**: the accepted `main` is recorded
on the machine that accepted it, so another clone would see those accepts as
unaccepted changes. A vault used on several machines uses `forge` mode.

In `forge` mode the package pushes the actor branch and its notes to the
vault's `origin`, and publishes each check as a commit status on the proposal
(`vault/check/<name>`) plus **`vault/policy`**: whether the proposal satisfies
the vault's merge policy, counting owners' forge approvals of that exact
commit. It never pushes `main` and learns of merges by fetching. Branch
protection on `main` requires `vault/policy` and, in the recommended setup, an
owner's approval; `vault doctor` checks it ([Security
setup](security-setup.md)). Owners are identified by their forge usernames.

A vault moves from `local` to `forge` by adding a remote and changing the mode;
nothing else changes.

Each vault has an **accepted `main`** — in `local` mode the commit `vault accept`
last produced or adopted, in `forge` mode the forge's `main` as last fetched.
Executable and instructional content is resolved only from it, and any other
change to `main` is reported until an owner accepts it. See
[Security model](security.md).

Commits made by the package carry trailers: `Vault-Trace`, `Vault-Actor` and, for
commits made from a Pi session, `Vault-Session` — plus `Vault-Tainted` once that
session is tainted, and always on a commit made through MCP. Their Git identity
is the actor's (or, for an owner act, the person's) name at the installation,
`<name>@<host>`, whatever the machine's Git configuration says.

## Trace

Every run gets a unique, time-sortable ID at spawn: 26 upper-case characters,
the issue time in milliseconds followed by randomness, so the time can be read
back from the ID. The ID propagates to everything the run causes.

- **In the vault**: a compact record — one line of JSON with `trace`, `vault`,
  `path` (the trace IDs of the runs that led to this one, root first),
  `trigger`, `sessions`, `judgements`, `scripts`, `documents` produced and
  `elsewhere` — as a Git note on `refs/notes/vault/traces` on each commit the
  run makes, as of that commit. `vault trace <id>` finds the commits by their
  `Vault-Trace` trailer and reads the notes, which travel and merge like
  attestations. A run that commits nothing leaves no record in the vault.
- **In produced documents**: a `provenance` key, `{ trace, path }`.
- **On the machine**: full logs in the log directory as JSON lines, per UTC day
  and trace, kept for a configurable number of days including today
  (default 7).

When a run spans vaults, each vault records only the part that happened in it;
other vaults appear in `elsewhere` as opaque references — derived from the
trace and the vault, naming neither, and different for every run.

## Installation

Machine-local configuration, `config.yaml` in the platform's configuration
directory (see [Architecture](architecture.md#data-locations)). It holds
everything that differs per machine or contains secrets.

```yaml
installation:
  name: alice@homeserver       # optional; defaults to <user>@<hostname> (see `vault whoami`)
  person: alice                # the person using this installation: default actor, local approver
vaults:
  - id: home-knowledge
    path: ~/vaults/home-knowledge
    worktrees: ~/vaults/home-knowledge-worktrees
    host: true                 # run this vault's background jobs here (default false)
models:                        # see Models below
  embed:     { url: "https://…/v1", token: "${EMBED_TOKEN}", model: mxbai-embed-large-v1, batch: 32, parallel: 4 }
  rerank:    { url: "https://…/v1", token: "${RERANK_TOKEN}", model: qwen3-reranker }
  judgement: { url: "https://…/v1", token: "${JUDGE_TOKEN}", model: d3 }        # strongest: the default
  classify:  { role: judgement, url: "https://…/v1", token: "${JUDGE_TOKEN}", model: d3-flash, parallel: 4 }
  agent:     { model: homeserver/qwen3.8-27b }                            # a model as Pi names it
  quick:     { role: agent, model: homeserver/qwen3.8-flash, parallel: 2 }   # fan-out items at once
forges:
  - { host: git.example.net, type: gitea, token: "${FORGE_TOKEN}" }   # api: optional, when the API is not at the usual place
mcp: { … }                     # see mcp.md
labels:
  equivalent: [[private:geopolitics, digests:geopolitics]]
subscriptions:
  - { from: digests, to: private }
policy:
  - { vaults: [home-knowledge], allow-models: [embed, rerank, judgement, classify, agent, quick] }
budgets: { daily-tokens: 2000000, cascade-pool: 300000, depth-decay: 0.5, max-depth: 4 }
taint:
  trusted-tools: [read, edit, write, vault_search, vault_read]   # all other tools taint a session
logs: { keep-days: 7 }
daemon: { queue-time: 24h, parallel: 1 }   # see daemon.md "Scheduling"
notify: { … }                  # see notifications.md
templates:                     # short names for template repositories
  research-digests: https://git.example.net/templates/research-digests.git
```

Secrets are given as `${ENV}` references or `!command` (any command that prints
the secret — a keyring lookup on each platform), never literally. They are
resolved where they are used, not when the config loads.

`policy` records which models may receive each vault's content: a model is
used for a vault only when an entry lists both, so a vault no entry names
sends nothing to any model. This covers background jobs too: a job's content
reaches only an `agent` model the policy allows for its vault.

The file is validated strictly when loaded: an unknown key, a literal secret or
any other invalid value is an error that lists every problem (without repeating
the values), so a typo cannot silently disable a feature. Vault and worktree
paths may start with `~` and must otherwise be absolute.

### Models

`models` maps names to models. The names are this installation's own: a
document or contract asks for a model by name, and each installation decides
what that name is, so a vault never depends on a particular model existing.

| Role | Used for | Speaks | Default entry |
|---|---|---|---|
| `judgement` | Judgement axes | `POST /v1/systemone`, the System One decisions protocol of llama.cpp's decision models and TypeSafe (see [Core library](components/core.md#judgements)) | `judgement` |
| `agent` | Background jobs | Pi: `model` is a model as Pi names it (`provider/id`), passed to the session; Pi holds its URL and credentials | `agent` |
| `embed` | Search vectors | OpenAI-compatible `POST /v1/embeddings` | `embed` (the only `embed` entry) |
| `rerank` | Search ranking | `POST /v1/rerank` (Jina / Cohere style) | `rerank` (the only `rerank` entry) |

- **Default entries** are named after their role, and their role is implied: a
  `role` that differs from the name is an error. Other names give their `role`
  explicitly; only `judgement` and `agent` may have more than one entry, so
  the one `embed` and the one `rerank` model are named after their roles. An
  `agent` model's `model` is exactly `provider/id`: Pi matches looser
  patterns on its own, and the policy is written for the model named here.
- **A request names a model; it never guarantees one.** An axis's or job's
  `model` that is not configured here is answered by its role's default,
  which `vault doctor` reports. Choose the strongest available model as each
  default, so that falling back is never a downgrade and faster models are
  always an explicit choice.
- **A named model with the wrong role** (an axis naming an `agent` model) is a
  problem `vault doctor` reports; the request fails as below.
- **Policy applies to the model actually used.** `allow-models` lists model
  names. A configured model the policy does not allow for the vault is never
  replaced by the default: the request fails. A job is checked at its claim
  and again when it starts, and a headless run starts only when Pi is running
  it on the `agent` model the daemon chose.
- **A missing model never stops anything else.** Without the model a request
  needs, its work does not happen, visibly: a job does not run (`vault jobs`,
  `vault status`), an axis stays unjudged and its requirement unmet, search is
  keyword-only or unranked — each reported by `vault doctor`. Interactive Pi
  sessions use the model the person chose in Pi.

HTTP models have `batch` (inputs per request; default 1) and `parallel`
(concurrent requests; default 1). Work is split into batches of `batch`
inputs, sent up to `parallel` at a time — so endpoints that batch properly and
endpoints that only handle one input per request both get full throughput.
Agent models have only `parallel`: how many fan-out items run at once on the
model (default 1).

## Built from the core

These are recipes, not additional concepts.

| Recipe | Built from |
|---|---|
| Job | A document with a `spawn` condition, a budget and an actor |
| Scheduled job | A job whose condition is a timer |
| Gate | A document that runs a judgement check when content arrives; policy decides the outcome |
| Memory | A document with session-event conditions and `inject` |
| Agent-memory vault | A vault whose merge policy needs only checks for content, and owners for tainted or control changes |
| Watch | A document linking personal facts to labels, spawning on matching merges |
| Feedback | A person's edit to a document, which a handler document spawns on |
| Delivery (email, notification) | A session that runs a delivery script; the vault is the outbox |
| Template | A vault repository marked as a template, used as a starting point (below) |

## Templates

A template is an ordinary vault repository whose root contract carries a
`template` key — the marker that says it is intended and compatible as a
starting point:

```yaml
---
template:
  name: research-digests
  version: 1
  summary: Scheduled research on chosen topics, with digests and standing notes.
vault:
  …
---
```

Creating a vault from a template copies its current content into a new
repository with fresh history, sets the new vault's `id`, and replaces the
`template` key with `vault.from-template` — the source URL and commit — so the
origin is recorded. The first commit is the new vault's accepted `main`. A
template is fetched only over https, ssh or from a local repository, and one
containing a symbolic link is refused.
