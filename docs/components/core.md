# Core library

The shared implementation. The CLI, extension and daemon are thin layers over
it; no vault logic lives anywhere else.

## Rules

- **No knowledge of its caller.** The core never imports Pi, the CLI or the
  daemon. Callers pass in what it needs: configuration, a clock, a logger.
- **Deterministic.** Given the same repository state and inputs, operations
  produce the same results. Time and randomness are injected.
- **Git is accessed only through the `git` module.** No other module runs `git`.
- **Processes are started only through the `process` module.** Git, secret
  commands and scripts all run through it.
- **HTTP requests are made only through the `http` module.** Model clients and
  forge adapters use it.
- **SQLite is accessed only through the `store` module.** No other module opens
  a database.
- **Errors are values.** Operations return typed results with a reason; they
  throw only for programming errors.

## Modules

| Module | Responsibility |
|---|---|
| `process` | Start a process: a program with an argument array, or an explicit shell command line; exactly the environment given; standard input closed unless input is given; bounded output; a time limit, past which the process is killed — with its process group on POSIX |
| `http` | Make a JSON request to a configured endpoint (a model role or a forge): never follows redirects, so a body or credential goes only to the URL given; a time limit; errors carry a status, never the response body |
| `config` | Load and validate the installation config; resolve `${ENV}` and `!command` secrets; resolve the platform's config and state directories |
| `registry` | The vaults on this machine: their paths, root contracts and catalog entries |
| `git` | Wrapper around the `git` command line: refs, notes, worktrees, diffs, merges, trailers |
| `documents` | Parse and write Markdown with frontmatter, preserving formatting of untouched content |
| `contracts` | Find `_contract.md` files, merge them into an effective contract with per-key strategies, report the origin of each key |
| `conditions` | Parse `applies-when`; match Git and session events against conditions; the path globs merge rules share |
| `events` | Derive Git events from a ref range (paths, change kinds, renames, labels, the actor and run that made each change) |
| `policy` | Evaluate merge rules against changed paths and attestations |
| `attestations` | Read and write attestation records in Git notes |
| `actors` | Actor branches and worktrees; the hold that keeps one writer per actor, void once its process has ended; proposals; review records; SHA-bound accept |
| `integrity` | The accepted `main` per vault: record it on accept and adopt, detect unaccepted changes, provide the notice every surface shows |
| `scripts` | Resolve built-ins and the vault's scripts and checks from the accepted `main`, parse headers, run them with their declared limits |
| `templates` | Validate a template's marker, create a vault from it with fresh history and recorded origin |
| `judgements` | Run judgement checks: build the state from a document, ask the contract's axes of the judgement model, apply `pass-when`, record the attestation (see Judgements) |
| `notify` | Validate recipients and messages, write to the outbox, deliver through the configured transport, retry |
| `budgets` | Allot budgets down a session tree; account for tokens; enforce limits |
| `traces` | Issue trace IDs; write compact records and provenance; write and rotate full logs |
| `store` | The only access to `state.sqlite` and `index.sqlite`: connections, pragmas, transactions, loading `sqlite-vec` into the index, and applying the schema migrations each module supplies for its own tables |
| `queue` | Spawn queue, claims and cursors, on top of `store` |
| `search` | Index documents per vault; keyword, vector and hybrid search; rerank; check each hit against the current content |
| `models` | Clients for configured model roles: embeddings, rerank, judgement. Splits work into batches of the role's `batch` size and sends up to `parallel` requests at a time. Never follows redirects, so content goes only to the configured URL |
| `forge` | Forge adapters (Gitea, GitHub, GitLab): push actor branches, open or update pull requests, publish commit statuses and `vault/policy`, read approvals and merges, check branch protection |
| `operations` | The catalogue of operations — name (also its permission), parameters, implementation, and which surfaces expose it (Pi tool, Pi command, CLI, MCP) — from which every surface is generated; permission sets and their evaluation; the complete list of module schemas each local store is opened with |

## Key interfaces

| Operation | Input | Output |
|---|---|---|
| `effectiveContract` | Vault, path | Merged contract with the origin of each key |
| `matchConditions` | Event, candidate documents | Matching `(document, condition)` pairs |
| `deriveEvents` | Vault, ref range | Git events |
| `review` | Vault, actor, reviewer | Commits, diff summary, check results, control-change flags; records the reviewed SHA as the reviewer's latest review |
| `accept` | Vault, actor, approver | Merge of the SHA from the approver's own latest review (recorded as the accepted `main`), or the reason it was refused — including the unmet requirements |
| `adopt` | Vault, SHA, approver | The delta from the accepted `main`, then the new accepted `main` once confirmed |
| `integrityStatus` | Vault | `accepted`, or the unaccepted change with its commits |
| `runScript` | Vault, script name, arguments | Exit status and output |
| `search` | Query, vault scope | Ranked hits, each with a freshness verdict |
| `enqueueSpawn` | Document, condition, event, parent trace | Queue entry or the existing claim |

## Search

- One index per installation, with the vault as a column. Queries are scoped to
  the vaults a session or job uses.
- Documents are indexed from the accepted `main`, and an update is refused
  while `main` has an unaccepted change. `.vault/` is never indexed; nor is a
  document whose governing contract cannot be read.
- Each chunk is indexed with a header naming its vault, document title and
  heading path; vectors are made from the header and the chunk's text.
- Ranking: keyword and vector results fused by rank, then reranked when a rerank
  model is configured.
- Each returned hit is checked against the accepted `main`: `current`,
  `changed`, `moved` (followed through renames) or `gone`.
- The index is disposable. It is rebuilt from Git and records the embedding
  model it was built with; a different model requires a rebuild.
- Whatever is missing — an embedding model, the policy's permission, the
  vector extension, a reachable model — reduces search to keywords, and the
  result says so.

## Judgements

A judgement check sends a document's content as state, with questions from the
contract's axes, to the judgement model, applies each axis's `pass-when` (see
[Concepts](../concepts.md#judgement-axes)), and records the outcome as an
attestation. The content hash, model and axes version are part of the record. A
judgement whose content has since changed is treated as missing.

The model speaks the System One protocol, as served by llama.cpp's decision
models and by TypeSafe. One request answers every axis:

```
POST <url>/systemone            Authorization: Bearer <token>
{ "model": "<model>",
  "state": { "vault": "<purpose summary>", "path": "…", "title": "…",
             "labels": […], "content": "…" },
  "questions": {
    "<axis>": { "type": "choice", "instructions": "…", "criteria": { "<option>": "<meaning>", … } },
    "<axis>": { "type": "score",  "instructions": "…", "criteria": ["<lowest level>", …] },
    "<axis>": { "type": "noul",   "instructions": "…", "criteria": { "true": "…", "false": "…" } } } }

200 { "answers": {
        "<axis>": { "type": "choice", "choice": "<option>", "probabilities": { "<option>": p, … }, "confidence": c },
        "<axis>": { "type": "score", "score": s, "confidence": c },
        "<axis>": { "type": "noul", "noul": p } },
      "usage": { "input_tokens": n, "output_tokens": n } }
```

`noul` is the protocol's name for `bool`; its `noul` is the probability of
`true`. A score is the expected level index, from 0. `usage` may be absent. A
response missing an axis or with a wrong type fails the judgement. Content is
never shortened to fit the model: content too large is a failed judgement.
