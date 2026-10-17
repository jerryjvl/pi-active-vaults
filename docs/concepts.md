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
| `budget` | `{ tokens, ttl }` — required on any document that can spawn work |
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
| `schedule`, `missed` | Timer only: cron expression; `run-once` or `skip` for runs missed while nothing was running |
| `paths`, `change` | Path globs and change kinds (`created`, `modified`, `deleted`, `renamed`) |
| `labels` | Match if the changed document carries any of these labels |
| `tools`, `model` | Session events: tool names; model ID |
| `name` | External events: the event name given to `vault trigger` |
| `context` | Spawn only: `session-preferred` (default), `bare`, `session-required` |

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
| `list-ops` | `[+x]` adds, `[-x]` removes, a plain list replaces |
| `tighten-only` | Deeper contracts may add requirements, never remove them |
| `locked` | Root contract only |

Contract keys:

| Key | Strategy | Meaning |
|---|---|---|
| `vault` | `locked` | Vault identity: `id`, `purpose`, `audience`, `owners`, `actors`; optionally `executor`, `review` and `from-template` |
| `template` | `locked` | Present only in a template repository: `name`, `version`, `summary` (see Templates) |
| `merge` | `tighten-only` | Merge rules (below) |
| `index` | `nearest` | `default`, `opt-in` or `none` — whether search includes the subtree |
| `naming` | `nearest` | Filename pattern for new documents, e.g. `"{topic}-{date}.md"` |
| `axes` | `merge` | Judgement questions: name → `{ type: bool \| choice \| score, instructions, options or levels, pass-when }`, where `pass-when` is the condition on the answer's probabilities that makes the judgement pass |
| `applies-when` | `list-ops` | Conditions that apply to every document in the subtree |

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
| `judgement:<name>` | The named judgement produced a passing outcome |

A rule may add `when-tainted: [...]` — extra requirements when the proposal came
from a session that read untrusted content.

**Control changes always need an owner.** Whatever the contracts say, a change
to any `_contract.md`, anything under `.vault/`, or the `applies-when` or
`budget` of any document requires `owner`. Agents may propose such changes;
review flags them.

## Session tree

Sessions start from a trigger and branch as they spawn work. Budgets flow down:

- A spawned session receives the smaller of its document's budget and its
  allotment from the root's **cascade pool**: the pool's remaining tokens ×
  `budgets.depth-decay` (default 0.5) per level of depth × the trigger's
  relevance score (1 when it has none).
- Tokens are counted as work: prompt and generated tokens of every request,
  including compaction, excluding cached-prefix reads.
- `ttl` is run time; queue time has its own limit.
- No document fires twice in one tree. `budgets.max-depth` (default 4) backs
  this up.

**Fan-out and gather** is the built-in multi-session shape: a list of items, an
instruction for each, an instruction to combine the results. The list can come
from anything the session can do.

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
prompt. Header lines are comments (`#` or `//`). A script runs with the
interpreter in its `#!` line; on Windows the package runs it through that
interpreter, or through Git for Windows' `sh` for shell scripts. A script
declaring `net: no` runs without network access where the platform allows it.

**Built-in scripts** ship with the package under the `builtin:` prefix and are
available to every vault. A vault cannot replace or shadow them. The first is
`builtin:notify` — see [Notifications](notifications.md).

**Checks** are scripts in `.vault/checks/` that assess a proposal and produce an
attestation. **Judgements** are checks that call a judgement-role model.

## Attestation and merge policy

An attestation records a verdict about an exact subject:

| Field | Meaning |
|---|---|
| `kind` | `check`, `judgement` or `approval` |
| `name` | Which check, judgement or approver |
| `subject` | Commit SHA or content hash |
| `result` | `pass`, `fail`, or a named outcome |
| `by` | Script and version, model and rules version, or person |
| `evidence` | Short supporting detail |

Attestations are stored as Git notes on `refs/notes/vault/attestations`, so they
travel with the repository. Accepting a proposal evaluates the merge policy
against the attestations for the exact commit under review.

## Actor

A named writer — an agent role or a person — with its own branch (default
`actor/<name>`) and worktree (`<worktrees>/<name>`, from the installation
config). Many jobs may write into one actor's branch; each actor's branch is one
review lane.

A **proposal** is an actor's branch ahead of `main`. The vault's root contract
chooses how proposals are reviewed (`vault.review`):

| Mode | Proposal | Approval | Merge |
|---|---|---|---|
| `local` (default) | Actor branch in the local repository | `vault accept` by an owner (the installation's `person` must be in `vault.owners`) | `vault accept`, of the reviewed SHA |
| `forge` | Actor branch pushed to the vault's remote, shown as a pull request | Owner review in the forge (Gitea, GitHub, GitLab) | The forge, gated by branch protection |

In `forge` mode the package publishes each check's attestation as a commit
status on the proposal, never pushes to `main`, and learns about merges by
fetching. The forge's branch protection on `main` requires those statuses and
an owner's approval; `vault doctor` verifies it is in place. Owners are
identified by their forge usernames.

A vault moves from `local` to `forge` by adding a remote and changing the mode;
nothing else changes.

Each vault has an **accepted `main`** — in `local` mode the commit `vault accept`
last produced or adopted, in `forge` mode the forge's `main` as last fetched.
Executable and instructional content is resolved only from it, and any other
change to `main` is reported until an owner accepts it. See
[Security model](security.md).

Commits made by the package carry trailers: `Vault-Trace`, `Vault-Actor` and, for
commits made from a Pi session, `Vault-Session`.

## Trace

Every run gets a unique, time-sortable ID at spawn. The ID propagates to
everything the run causes.

- **In the vault**: a compact record, `.vault/traces/<yyyy>/<mm>/<trace-id>.json`
  — triggers, sessions, judgements, scripts run, documents produced — committed
  with the run's other changes on its actor branch.
- **In produced documents**: a `provenance` key with the trace ID and the causal
  path.
- **On the machine**: full logs in the log directory, kept for a configurable
  number of days (default 7).

When a run spans vaults, each vault records only the part that happened in it;
other vaults appear as opaque references.

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
models:
  embed:     { url: https://…/v1, token: ${EMBED_TOKEN}, model: mxbai-embed-large-v1, batch: 32, parallel: 4 }
  rerank:    { url: https://…/v1, token: ${RERANK_TOKEN}, model: qwen3-reranker }
  judgement: { url: https://…/v1, token: ${JUDGE_TOKEN}, model: laya, parallel: 4 }
forges:
  - { host: git.example.net, type: gitea, token: ${FORGE_TOKEN} }
mcp: { … }                     # see mcp.md
labels:
  equivalent: [[private:geopolitics, digests:geopolitics]]
subscriptions:
  - { from: digests, to: private }
policy:
  - { vaults: [home-knowledge], allow-models: [embed, rerank, judgement] }
budgets: { daily-tokens: 2000000, cascade-pool: 300000, depth-decay: 0.5, max-depth: 4 }
taint:
  trusted-tools: [read, edit, write, vault_search, vault_read]   # all other tools taint a session
logs: { keep-days: 7 }
notify: { … }                  # see notifications.md
templates:                     # short names for template repositories
  research-digests: https://git.example.net/templates/research-digests.git
```

Secrets are given as `${ENV}` references or `!command` (any command that prints
the secret — a keyring lookup on each platform), never literally.

Each model role speaks one HTTP API:

| Role | API |
|---|---|
| `embed` | OpenAI-compatible `POST /v1/embeddings` |
| `rerank` | `POST /v1/rerank` (Jina / Cohere style) |
| `judgement` | `POST /v1/systemone` decisions (state plus typed questions → probabilities) |

Each role has `batch` (inputs per request; default 1) and `parallel` (concurrent
requests; default 1). Work is split into batches of `batch` inputs, sent up to
`parallel` at a time — so endpoints that batch properly and endpoints that only
handle one input per request both get full throughput.

## Built from the core

These are recipes, not additional concepts.

| Recipe | Built from |
|---|---|
| Job | A document with a `spawn` condition and a budget |
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
origin is recorded. The first commit is the new vault's accepted `main`.
