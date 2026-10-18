# Progress log

Maintained by the implementing agent; read by the reviewer. Newest stage last.

**Branch:** `impl/v1`
**Current stage:** 6a — daemon core, in progress

## Current stage status

Kept current with every commit, so an interrupted session can resume.

- **Done:** Stage 5 review decisions: `builtin:notify` exits 3 on refusal; a job runs as its `actor` (frontmatter, else nearest contract; one of the vault's `actors`).
- **Done (6a):** item 1, trace capture (each commit carries the run's compact record; tool results, turns, start and end in the `session` full log).
- **Done (6a):** item 2, one cache for reads from the accepted main (`integrity/reads.ts`, `context.reads`).
- **In progress:** item 3, the daemon.
- **Next:** refactoring pass and the Stage 6a entry. Stage 6b (MCP, forge sync scheduling, outbox retry) waits for the next session.

## Stage entries

<!--
Copy this block for each stage:

### Stage N — <name>

- **Commits:** `<first>..<last>` on `impl/v1`.
- **Results:** test and type-check outcome (counts), and the commands run.
- **Built:** modules and commands, briefly.
- **Tests:** what is covered, including fail-closed cases.
- **Refactoring:** what the pass changed and why.
- **Decisions:** interpretations of ambiguous documentation.
- **Needs owner approval:** proposed documentation changes (commit references).
- **Gaps:** anything untested or deferred, including platform-specific paths.
- **Review findings addressed:** for stages after a review, how each finding
  was handled.
-->

### Stage 0 — Scaffold

- **Commits:** `28dd9a9..` on `impl/v1` — scaffold, layer test, test support, and this log entry as the last commit.
- **Results:** `npm test`: 13 tests, 13 pass. `npm run check` (`tsc --noEmit`, TypeScript 7.0.2): no errors. Node v24.18.0, npm 11.16.0.
- **Built:** `package.json` (Node ≥ 22.18, ESM, `pi` manifest, `vault` bin, Pi packages as `"*"` peer dependencies), `tsconfig.json` (strict, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), `bin/vault.js` placeholder, empty `src/core`, `test/support` (temp Git repos, fake clock and IDs, HTTP stub server, layer checker).
- **Tests:** layer test over the real `src/` tree plus the checker proven on synthetic trees: lower→higher import, core→adapter, core→Pi, and an unassigned core module all fail closed; same/lower-layer and adapter→core pass. Support self-tests cover the clock, IDs, repo isolation from global Git config and cleanup, and the stub server (including 500 on handler failure).
- **Refactoring:** nothing to consolidate yet; no duplication or stale comments found.
- **Decisions:**
  - Tests run via an explicit glob (`test/**/*.test.ts`) so support files are not executed as tests.
  - Core layout is `src/core/<module>/`; the module→layer map lives in `test/support/layers.ts` and must be extended if a module is added. `judgements` is treated as an L2 module (the plan lists it in L2, `core.md` does not list it as a module).
  - Test support spawns `git` directly (core/git does not exist yet); the rule governs `src/`.
  - `FakeClock`/`FakeIds` are provisional shapes; Stage 1 defines the core `Clock`/`IdSource` types and the fakes must then implement them.
  - `bin/vault.js` is a placeholder that exits 1; `pi.extensions`/`pi.skills` point at paths that do not exist yet (`src/extension/index.ts`, `skills/`).
- **Needs owner approval:** none proposed. Please note: (1) Installed Pi on this machine is **0.82.1**, below the ≥ 1.3 the design requires; installing the peer dependencies placed Pi **1.3.0** in `node_modules` (pre-approved dev dependency), which Stage 5 should use rather than the global Pi. (2) Node does not strip types for files under `node_modules`, so a published package that ships `.ts` source will not run its `vault` bin from there; how to ship (build step vs. other) needs a decision before Stage 4.
- **Gaps:** none for this stage. npm reported two transitive packages with install scripts that were not run (`@google/genai`, `protobufjs`, via Pi); not relevant to this package.
- **Review findings addressed:**
  1. *Merge `main`:* `main` merged into `impl/v1` (`312eecb`); it brought the `judgements` entry in `core.md`, which the layer map already assumed.
  2. *Pin Pi host packages:* `@earendil-works/pi-{agent-core,ai,coding-agent,tui}` are dev dependencies at `^1.3.0` (`f46b9aa`), still `"*"` peers. `typebox` is `~1.3.27`, the version Pi itself depends on, rather than `^1.3.0` (its own line is 1.3.x–1.4.x; the unpinned peer had installed 1.4.1, a second copy next to Pi's). A test checks every peer has a dev dependency and that the Pi packages stay at `^1.3.0`.
  3. *Shipping:* `npm run build` compiles `src/` to `dist/` (`tsconfig.build.json`, `rewriteRelativeImportExtensions`, clean first); `bin` and `pi.extensions` point at `dist/`; `files` is `dist` and `skills`; tests and `npm run check` still use source (`8d04455`). The placeholder launcher moved from `bin/vault.js` to `src/cli/main.ts`. `docs/architecture.md` "Technology" updated. A test builds a fixture and runs the output under plain Node to prove the extension rewrite; another checks the manifest and that there are no npm lifecycle scripts. Not done: a `prepack` build, since AGENTS.md §6 forbids lifecycle scripts, so `npm run build` must precede `npm publish` (the package is `private` for now) — see Stage 1 "Needs owner approval".

### Stage 1 — Foundations (L0)

- **Commits:** `2a650d8..` on `impl/v1` — tests-first and implementation commits per module (`result`/`clock`/`ids`, `config`, `store`, `git`, `documents`), the `yaml` dependency, a refactor commit, and this log entry as the last commit. The `test(…)` commits fail until the commit after them (that is the plan's loop: tests first); every `feat`/`refactor` commit passes.
- **Results:** `npm test`: 148 tests, 148 pass. `npm run check` (`tsc --noEmit`, now with `noUnusedLocals`/`noUnusedParameters`): no errors. `npm run build`: compiles, and the compiled core modules import under plain Node. Node v24.18.0, git 2.55.0.
- **Built:** in `src/core/`:
  - `result` — `Result`, `ok`, `err`.
  - `clock` — `Clock`, `systemClock`.
  - `ids` — ULID-shaped, strictly increasing IDs from an injected clock and randomness; `isTraceId`, `traceIdTime`.
  - `config` — `Host` and `platformDirs`/`installationPaths` (Linux, macOS, Windows, overrides), `ensurePrivateDir`, `SecretRef` with `parseSecretRef`/`resolveSecret`/`shellCommandRunner`, and `parseInstallationConfig`/`loadInstallationConfig` for the documented config.
  - `store` — `openStore` over `node:sqlite` with migrations, `BEGIN IMMEDIATE` transactions, WAL, busy timeout, private files; `openStateStore`/`openIndexStore`.
  - `git` — repositories, revisions and refs (compare-and-swap), history, changed paths and diffs, files at a revision, commits with trailers, SHA-only merge, worktrees, notes.
  - `documents` — `parseDocument`, `updateFrontmatter`.
- **Tests:** each module's documented behaviour, including:
  - *Platforms:* Linux, macOS and Windows path branches through injected hosts, and override handling.
  - *Config and secrets:* a literal secret, an unset variable, a failing, empty or timed-out command, and malformed YAML each fail closed without echoing values or file content.
  - *Store:* migrations apply once under concurrent opens, a newer schema is refused, a failed migration rolls back, a second writer is refused, a unique-insert claim, 0600/0700 modes.
  - *Git:* option-, range- and path-injection refused before git runs; ambient `GIT_DIR` ignored; merge takes a SHA only, refuses a dirty tree, and undoes a conflict; external diff and textconv never run; user hooks and signing are not triggered; reads come from the revision, not the working tree.
  - *Documents:* unterminated, invalid, non-mapping, duplicate-key and alias-bomb frontmatter are errors; an update leaves every other byte unchanged (comments, quoting, CRLF, BOM).
  - *Boundaries:* a test keeps `node:sqlite` in `store` and process spawning in `git` and secret commands. `test/package.test.ts` covers the packaging rules.
- **Refactoring:** `git` gained one `runChecked` replacing the run / check-exit / convert-failure sequence repeated in four files; note writes share one validated path; range and diff ends share one resolution. Test wrappers `withTempRepo`/`withTempDir` replaced four copies (and fixed two tests that leaked a temp repository). Unused-code checks are on. Nothing found stale in comments or docs after the pass.
- **Decisions:**
  - `<config>`/`<state>` in `architecture.md` are the application directory (`<base>/pi-active-vaults`); an override replaces the whole directory and must be absolute, a relative one is an error.
  - A missing config file is a `not-found` error value; whether that means "nothing configured" is for the callers.
  - The config is strict: an unknown key anywhere in a known section is an error (a typo must not silently disable a feature). `mcp` and `notify` are passed through as plain mappings for the modules that own them (L1–L2) to validate.
  - Secrets stay `SecretRef`s and are resolved by the user of the secret; `!command` runs through the platform shell (`sh`, or `cmd.exe`) with no stdin and a 10 s timeout. Errors name the config field only.
  - Documented-silent defaults: `taint.trusted-tools` empty (every tool taints — fail closed), `worktrees` optional (the default location is for the `actors` stage), `host` false, `batch`/`parallel` 1, `keep-days` 7, `depth-decay` 0.5, `max-depth` 4. Vault ids match `[A-Za-z0-9][A-Za-z0-9._-]*`; `keep-days`, `batch` and similar must be positive whole numbers; `depth-decay` is in (0, 1].
  - `store` owns the state and index schemas as append-only migration lists (`user_version` is one linear history for a file several modules share, and the layers forbid `store` importing them). Later stages append migrations there; both lists are empty now.
  - Transactions are synchronous callbacks; an async callback or a nested transaction throws (programming error). A busy file past the timeout throws the driver's error.
  - Package commits use `--no-verify` and `--no-gpg-sign`, and run under `GIT_LITERAL_PATHSPECS`, with `core.fsmonitor` off. Git's ambient `GIT_*` repository variables are removed so a daemon started from a hook cannot be redirected.
  - Git needs 2.36 (`worktree list -z`); `docs/architecture.md` says so.
  - `git` functions take a `Git` context first and the repository directory second, rather than being methods of a class.
  - Git notes writes are not compare-and-swap (Git has no such option); a lost concurrent note fails closed for attestations. The `attestations` stage should re-read after writing.
  - Frontmatter is YAML 1.2 core: dates and words like `yes` stay strings.
- **Needs owner approval:**
  1. *Unsigned package commits.* `security-setup.md` lists "required signed commits on `main`" as optional hardening; the package's commits on actor branches are unsigned by design (a signing prompt would hang headless runs). If signed commits matter for forge mode, the design needs to say who signs.
  2. *Publishing.* AGENTS.md §6 forbids npm lifecycle scripts, so there is no `prepack` build: `npm run build` must run before `npm publish` (the package is `private` for now). Say if a `prepack` script is acceptable.
  3. No documentation change is proposed. Small accuracy additions were made in the same commits: the config validation and trace ID shape in `concepts.md`, and the git version in `architecture.md`.
- **Gaps:**
  - Tests ran on Node 24.18 / git 2.55 on Linux only; Node 22.18 (the declared minimum) and git 2.36 are untested.
  - Real Windows and macOS: only the path branches are tested (injected). Unverified on a real platform: `!command` through `cmd.exe`, private-directory permissions on Windows (relies on the profile directory's ACL), and git path formats on Windows.
  - Notes writes race as described under Decisions.
  - Revisions, refs and branch names are checked against an allow-list (ASCII letters, digits and `._/@+-~^{}`); a repository using other characters in ref names, such as non-ASCII, gets `invalid-argument` rather than a pass-through.

### Stage 2 — Vault model (L1)

- **Commits:** `d8217ac..` on `impl/v1` — the Stage 1 review findings first (`d8217ac`–`56b20fa`), the documentation proposal (`4efd656`), then tests-first and implementation commits per module, two refactor commits for the consolidation pass, and this entry as the last commit. As in Stage 1, each `test(…)` commit fails until the commit after it; every other commit passes.
- **Results:** `npm test`: 297 tests, 297 pass, none skipped. `npm run check`: no errors. `npm run build`: compiles, and every compiled core module imports under plain Node. Node v24.18.0, git 2.55.0, Linux; the `net: no` test ran against a working `unshare`.
- **Built:** in `src/core/`:
  - `conditions` — the path glob syntax (shared with merge rules), strict `applies-when` parsing, event matching across subscriptions and label equivalence.
  - `contracts` — the five merge strategies with origins, `applyListOps` (the list syntax MCP permissions will reuse), reading the governing chain at a commit.
  - `registry` — vault identity from the root contract, registered vaults with default worktrees, catalog, hosting, owner and actor membership.
  - `events` — `merged` and `committed` events with changes, renames and labels.
  - `attestations` — verdicts as JSON lines in notes on `refs/notes/vault/attestations`.
  - `integrity` — the accepted `main` (branded `AcceptedMain`), unaccepted-change status, the guard every propagating action uses, the notice, adopt.
  - `scripts` — headers, injected built-ins, resolution of scripts and checks from the accepted `main`, interpreter and network isolation per platform, bounded runs.
  - `policy` — merge rules, control changes, a pure evaluator, `evaluateMerge`.
  - `actors` — trailers and taint, worktrees, actor commits, proposals, review records, SHA-bound accept.
  - `operations/stores.ts` — the per-file lists of module schemas (`integrity`, `actors` in `state.sqlite`).
  - Additions below L1: `git` (tree listing with modes and blob SHAs, merge base, first-parent history, text and path-type reads, `isSha`, `gitExecPath`), `documents` (`readDocumentAt`, `labelsOf`, `describeDocumentError`), `result` (`DataReader`, `Issue`), `config` (`installationPaths.worktrees`, `VAULT_ID`), `store` (per-module schemas).
- **Tests:** each module's documented behaviour, and fail-closed cases for every security behaviour in scope:
  - *Scripts from the accepted `main`:* the working tree's, `main` tip's and a branch's versions never resolve or run, support files included; a run is refused during an unaccepted change and nothing runs; a vault script named like a built-in, two files of one name, a symlink or a bad header are unusable; a misspelt `net` key is an error; `net: no` really blocks a connection to a local server.
  - *Unaccepted changes:* new commits, reset, rewrite, deleted `main` and none-accepted are each detected and noticed; the guard refuses until adopted or reset; adopt needs an owner, the exact current tip and local mode; recording is compare-and-swap.
  - *SHA-bound accept:* a branch moved after review, no review, a non-owner, an unaccepted change, forge mode, an unmet policy and `main` not checked out are each refused with `main` untouched; the merge is of the reviewed SHA, its first parent the accepted `main`.
  - *Merge policy:* rules come from the accepted `main` even when the proposal rewrites them; attestations count only for the exact commit; checks only at their accepted-main version; approvals only from owners, and a withdrawn one does not count; control changes always need an owner (case variants and unreadable frontmatter included); `when-tainted` applies to tainted proposals, including commits made outside the package; an unreadable policy blocks.
  - *Judgement staleness:* a judgement counts only for the current content (blob) and axes version; a deleted path needs an owner instead.
  - *Attestations:* any unreadable or misplaced record fails the read; malformed records are refused before writing.
  - *Store:* a file with any newer or unknown module, or newer bookkeeping, is refused; a module's migrations cannot touch another's tables; every exported schema is assembled into exactly one file.
  - *Boundaries:* layers, no import cycles (new), SQLite only in `store`, processes only in `git`, secret commands and `scripts/run.ts`.
- **Refactoring:** (per stage, and the whole-codebase pass)
  - config's private reader became the shared `DataReader` (with `oneOf`, `result`, and missing told apart from malformed), used by config, conditions, contracts, registry, scripts and policy; `ConfigIssue` became `Issue`.
  - One reader of documents at a revision (`readDocumentAt`) replaced three near-copies in contracts, events and policy, keeping missing, unreadable and read apart.
  - One SHA predicate (`isSha`) replaced a second regex in attestations.
  - Per-check statuses are computed once in policy and both drive the `checks` requirement and appear in review.
  - Exports used nowhere outside their module were made internal again (listed in `99e7fce`).
  - Test support gained `TestVault` (`withTestVault`, `propose`, `accept`), `scriptSource`, `TEST_ATTRIBUTION`, replacing copies across test files; the layer test now also refuses import cycles.
  - Comments and documents checked against behaviour; `core.md` updated for `store`, `operations` and `conditions`.
- **Decisions:**
  - *Store:* `user_version` is store's own bookkeeping format; versions per module live in `store_versions`. Module names are lower-case words and every object a module creates is named `<module>_…`, checked after its migrations run. A file holding a module this code was not given is refused as newer, so every opener passes the complete list from `operations`.
  - *Globs:* `**` (whole segment), `*`, `?` and `{a,b}` within a segment; everything else literal; character classes refused; case-sensitive; `*` and `**` match dot-files.
  - *Conditions:* `inject` only with session events; `model` filters any session event; a path filter never matches another vault's event; label equivalence groups are not transitive; a timer schedule is only checked to have five fields (its meaning is checked where timers run).
  - *Contracts:* shape checks only (each value's meaning is checked by its owning module); `merge` (axes) replaces whole entries by name; tighten-only concatenates rules root first; a `-` that matches nothing and a `+` already present are no-ops; a locked key outside the root is an error; whether a path is a directory is read from the tree.
  - *Events:* both kinds follow first parents; `committed` skips merge commits; unreadable frontmatter carries no labels.
  - *Registry:* the identity is strict; at least one owner; owner and actor names must be safe as branch and directory names; a registration whose id differs from the root contract's is refused (`checkRegisteredIdentity`).
  - *Integrity:* the accepted `main` is kept in `state.sqlite` in both modes (forge sync will record it with `how: sync`); the branch is `main`; adopt takes a full SHA that must still be `main`'s tip, with owners and mode from the accepted `main` (from the adopted commit only for a vault never accepted).
  - *Scripts:* scripts are the top-level, non-hidden files; the header block ends at the first non-entry line and allows only the documented keys; a `#!` line is required; built-ins exist only for scripts, not checks, and run in-process (reported `unrestricted`); each run copies the script directory from the accepted `main` into a private temp dir; the environment is exactly what the caller passes; stdout is capped at 1 MiB and stderr at 64 KiB; a timeout kills the process group on POSIX.
  - *Policy:* every check on the accepted `main` is blocking (no non-blocking kind is defined), and `checks` is met trivially when there are none; a check's version is its blob SHA; a judgement's version is the SHA-256 of its canonical axis definition; changes are taken from the merge base, and a rename's old path is treated as deleted.
  - *Actors:* an actor branch starts at the accepted `main`; commits are refused off the actor's branch; review keeps the latest record per actor, by any reviewer; accept takes the reviewed SHA from that record rather than as an argument (core.md lists it as an input — this is that SHA, stored), records the owner's approval before evaluating (so an owner's accept satisfies `owner`), merges in whichever worktree has `main` checked out, and records nothing if `main` moved during the merge.
  - *Trailers:* `Vault-Tainted: yes`; any value marks taint; keys compare case-insensitively.
- **Needs owner approval:**
  1. `4efd656` — documentation of formats the design left open, implemented against: attestation storage (JSON lines in the subject's note; `version` and `at`; latest per kind and name; checks count only at their accepted-main version, judgements only for current content and axes); `Vault-Tainted` and when a proposal is tainted; judgement rules route deleted paths to `owner`; list-ops on mapping items (`+: {…}` / `-: {…}`); unknown contract keys merge `nearest`; contract paths are vault-root relative; actors are `actors` ∪ `owners`; script naming and required header keys (and, added with `scripts`, hidden files are support files); `missed` defaults to `run-once`; default worktrees under `<state>/worktrees/<vault-id>`.
  2. Proposed, not done: three places spawn processes with their own timeout and output handling (`git/exec.ts`, `config/secrets.ts`, `scripts/run.ts`). One L0 process runner would remove the duplication but needs a new core module and changes reviewed Stage 1 code, so it is raised rather than done.
  3. Stage 1's open items are resolved by `main`: signed commits were removed from `security-setup.md`, and `prepack` is allowed (finding 4).
- **Gaps:**
  - Real Windows and macOS runs: interpreter and isolation command lines are tested as pure functions only. Unverified: Git for Windows' `sh` location, `.cmd`/`.bat` interpreters (not found without a shell), killing a timed-out script's children on Windows (only the interpreter is killed), `sandbox-exec` on a real Mac, worktree path comparison through symbolic links.
  - `net: no` needs unprivileged user namespaces on Linux; where they are restricted the probe reports `none` and runs say `unrestricted`.
  - Timers: schedules are shape-checked only; cron evaluation, `missed` and timer matching come with the daemon (Stage 6).
  - Forge mode: recording the accepted `main` on sync, fetching and pushing notes, and the forge's own approvals come with `forge` (Stage 3).
  - Taint depends on writers: the extension (Stage 5) must add `Vault-Tainted`, and `vault sync`'s merge commits must carry `Vault-Trace`, or they will mark proposals tainted.
  - Notifying the owner once of an unaccepted change is the daemon's (Stage 6).
  - One test waits 100 ms of real time (a script's time limit).
  - Untested: accepting when `main` is checked out in a worktree other than the vault's own directory.
  - As in Stage 1, only Node 24.18 and git 2.55 were used; the declared minimums (Node 22.18, git 2.36) are untested.
- **Review findings addressed:**
  1. *Merge `main`:* merged (`d8217ac`); it brought the interruption guidance (this log's *Current stage status*), `prepack` permission, per-module schema versions and git ≥ 2.36 in the README.
  2. *Per-module schema ownership:* `store` keeps only its own `store_versions` table and applies the `ModuleSchema`s it is given, refusing a file in which any module is newer or unknown; each module exports its schema (`integritySchema`, `actorsSchema`); `operations/stores.ts` assembles the lists and opens the files; a test checks every exported schema is assembled (`56b20fa`).
  3. *Trailers in the repository's directory:* `addTrailers` takes the repository and runs `interpret-trailers` there; a test with a repository-local `trailer.where` proves it (`612e112`).
  4. *`prepack`:* `"prepack": "npm run build"`; the package test forbids every install-time lifecycle script and requires `prepack` to be the build; `architecture.md` says so (`f611999`).

### Stage 3a — Work machinery, first half (L2): traces, budgets, queue, models, search

- **Commits:** `0eedbd2..` on `impl/v1` — the Stage 2 review findings first (`0eedbd2`, `2ed0663`, `4fe2444`), the `sqlite-vec` dependency (`4c7955e`), then tests-first and implementation commits per module, the refactor commit (`f223ef8`), the documentation proposal (`c479714`), and this entry as the last commit. As before, each `test(…)` commit fails until the commit after it; every other commit passes.
- **Results:** `npm test`: 386 tests, 386 pass, none skipped. `npm run check`: no errors. `npm run build`: compiles, and all 23 compiled core modules import under plain Node. Node v24.18.0, git 2.55.0, Linux; `sqlite-vec` 0.1.9 loaded from its prebuilt package.
- **Built:** in `src/core/`:
  - `process` (L0, finding 4) — `runProcess`: a program with an argument array or an explicit shell command line, exactly the given environment, closed standard input unless input is given, output bounded per stream, a time limit that kills the process group on POSIX.
  - `traces` — `newTraceId`; compact records (`compactTracePath`, `renderCompactTrace`, `parseCompactTrace`, `writeCompactTrace`, `opaqueReference`); provenance (`withProvenance`, `provenanceOf`); full logs (`appendFullLog`, `readFullLog`, `rotateLogs`).
  - `budgets` — `parseBudget`, `workTokens`; the session tree in `state.sqlite`: `allot`, `startSession`, `accountUsage`, `finishSession`, `budgetState`.
  - `queue` — `enqueueSpawn` (claim + trace + allotment in one transaction), `startSpawn`, `commitSpawn`, `stopSpawn`, `recordSpawn`, `markAwaited`, `nextSpawns`, `expireQueued`, `listSpawns`, `spawnEventKey`; cursors (`readCursor`, `advanceCursor`, `gitStream`, `timerStream`).
  - `models` — `modelFor` (a branded `PermittedModel`, after configuration and policy), `inBatches` (batch × parallel), `embed` and `rerank` clients.
  - `search` — schema in `index.sqlite` (documents, chunks, FTS5 kept in step by triggers, vectors, the embedding model), `chunkDocument`, `updateIndex`, `search`, `freshnessChecker`.
  - Additions below L2: `store` loads `sqlite-vec` for the index (`vectors`); `clock.utcDay`; `git.TREE_MODES`, `timed-out` and `output-too-large` errors; `documents.PACKAGE_DIRECTORY`/`inPackageDirectory`; `operations/stores.ts` assembles `budgets`, `queue` and `search`.
- **Tests:** each module's documented behaviour without network (local stub servers only), and fail-closed cases:
  - *Accept (finding 2):* a review by another owner or by the actor never satisfies an owner's accept, records no approval and leaves `main` alone; accept uses the approver's own latest review even when someone else reviewed the current tip; existing reviews survive the migration under their reviewer.
  - *Processes:* arguments are never shell-interpreted; nothing of the caller's environment is inherited; standard input is closed; output limits are reported; a timeout kills a background grandchild holding the pipes; a missing program is a value; git time-outs and oversized output are errors, never shortened results; a secret command sees only the given environment and fails on oversized output.
  - *Index from the accepted `main` only:* working-tree text is never searchable; an index update during an unaccepted change is refused and leaves the index unchanged; `index: none` is never searched, `opt-in` only within a scope, `.vault/` and non-documents never; a subtree under an unreadable contract is left out.
  - *Models and policy:* no vault content reaches an embed or rerank model the policy does not allow (no request reaches the stub); an unconfigured role is a value; HTTP errors, malformed responses, timeouts, unreachable endpoints and unresolvable tokens fail closed, and no error contains the token.
  - *Search:* query text never acts as FTS5 syntax; vectors find what keywords miss; rerank reorders; freshness `current`/`changed`/`moved`/`gone`; degradation without a model, without permission, without the vector extension, with a failing model, and after a model change, each reported.
  - *Budgets and queue:* allotment by depth, relevance and reservation; once per tree, max-depth, pool exhaustion, unknown parent and the daily ceiling each refuse; a claim is unique across connections and all-or-nothing; each state change only from the state before it; ordering; queue-time expiry; cursors compare-and-swap.
  - *Traces:* malformed records refused whole; path-escaping trace IDs and log names refused; log files private; rotation idempotent and limited to day directories.
  - *Boundaries:* only `process` imports `node:child_process` (or `child_process`); `node:sqlite` and `sqlite-vec` only in `store`.
- **Refactoring:** (`f223ef8`) one home each for tree modes (`git.TREE_MODES`), the package directory (`documents.inPackageDirectory`, case-insensitive as policy already was — search's `.vault/` exclusion now ignores case too) and the UTC day (`clock.utcDay`); `TRACES_DIRECTORY`, `PROVENANCE_KEY` and `MAX_CHUNK_CHARS` made internal; test support gained `withStore`, replacing three copies. The process module removed the three spawning implementations and the bounded-output copy in scripts. Comments and documents checked against behaviour.
- **Decisions:**
  - *Process:* every run must give a time limit and output limits. git defaults to 10 minutes and 256 MiB of output (`GitOptions` override). A secret command now runs with `SecretDeps.env`, not the ambient environment. On Windows only the direct child is killed.
  - *Review records:* kept per reviewer through an appended migration (migration lists stay append-only), not by editing version 1.
  - *Traces:* one `trigger` per record; session `outcome` is `committed` or `stopped`; an opaque reference is `ref:` plus 16 hex digits of SHA-256 over trace and vault; `writeCompactTrace` only writes into the worktree (the run's commit includes it); log names are `[a-z0-9][a-z0-9._-]*`; a day's age is counted in whole UTC days, and a day is deleted at age ≥ `keep-days`.
  - *Budgets:* the cascade pool belongs to the root, and the root's own use does not draw from it; the daily ceiling also caps a root's allotment; an allotment under one token is `pool-exhausted`; a relevance outside 0–1 is a programming error; interactive sessions may be allotted without a document; budgets do not check trace ID format.
  - *Queue:* `matched` and `claimed` are not stored as states — the claim is the insert, which records the spawn as `queued`, or `stopped` with the tree's refusal as the reason (the spawn stays claimed and never refires for that event). Event keys: `<kind>:<vault>:<commit>`, `timer:<at>`, otherwise `<kind>[:<vault>]:<id>`, with `manual` for `vault run`. The documented scheduling order is read lexicographically: awaited, then depth, then root, then claim order. Queue time is measured from the claim; its limit is a parameter.
  - *Models:* `policy` is an allow list (see Needs owner approval); a call involving no vault's content needs no policy entry. The configured URL is the API base; paths `embeddings` and `rerank` are appended. Per-request timeout 60 s by default; errors carry the HTTP status, never the body. Rerank sends `top_n` equal to the batch and assumes scores are comparable across batches.
  - *Search:* vectors are plain rows ranked with `vec_distance_cosine`, not a `vec0` virtual table, so the schema never needs the extension. Title: frontmatter `title`, else the first `#` heading, else the file name. Chunks of at most 1500 characters; header `vault · title · heading › path`. FTS5 with `unicode61 remove_diacritics 2`; query words quoted and OR-ed; reciprocal rank fusion with k = 60 over 100 candidates each (all matches when a scope is given); rerank of the top max(3 × limit, 30), only when allowed for every vault searched. The embedding model is recorded index-wide by model ID; no record counts as `model-changed`. A document with unreadable frontmatter is indexed as plain text; symbolic links are skipped; contracts' prose is indexed.
- **Needs owner approval:**
  1. `c479714` — documentation of the formats and semantics implemented against: budget `ttl` syntax; allotments held until their session ends; a tree without `cascade-pool` bounded only by budgets, max-depth and the daily ceiling; the daily ceiling per UTC day; the compact record's keys, provenance as `{ trace, path }`, logs per UTC day with retention counting today, per-run opaque references; `policy` as an allow list; `opt-in` meaning "within an explicit scope"; what is never indexed; reported degradation; `store` loading `sqlite-vec`.
     Two of these change what a user sees and deserve a look: with `policy` as an allow list, a config with models but no `policy` gets keyword-only search (`vault doctor` should say why); and without `cascade-pool` the pool does not limit cascades at all.
  2. **Blocked:** the judgement API (`POST /v1/systemone`). Its request and response shapes are not documented anywhere, so the judgement client was not written rather than guessed; listed as an open question in `core.md`. Judgements (Stage 3b) need it: please give the shapes or a reference.
- **Gaps:**
  - Stage 3b: judgements, `notify`, `templates`, `forge`, and the judgement model's client.
  - The queue-time limit has no configured value (no config key is documented); the daemon (Stage 6) must supply it, as it must the per-model capacity for scheduling.
  - Search ranks chunks: several chunks of one document can appear among the hits. Vector ranking is brute force over the searched vaults' vectors; fine for personal vaults, untested at scale. Freshness lists each searched vault's tree once per query.
  - `sqlite-vec` ships builds for Linux and macOS (x64, arm64) and Windows x64 only; elsewhere search is keyword-only (reported).
  - Windows: a timed-out process's children are not killed (only the process itself); shells run through `cmd.exe`; untested on a real machine.
  - Real-time waits in tests: process time limits (100–200 ms), polling up to 2 s for a killed grandchild to disappear, a 100 ms git time-out, and the earlier 100 ms script time-out.
  - Full logs do not redact; callers must keep secrets out of what they log.
  - As before, Node 22.18 and git 2.36 (the declared minimums) are untested.
- **Review findings addressed:**
  1. *Documentation proposal `4efd656`:* approved as is; nothing changed.
  2. *Accept bound to the approver's own review* (`0eedbd2`): review records are kept per reviewer (an appended `actors` migration moves existing rows under their reviewer); accept reads only the approver's latest record and refuses with `not-reviewed` (naming the approver) otherwise, before recording any approval. Fail-closed tests: another owner's or the actor's review of the exact tip, and a later review by someone else, never satisfy the owner's accept; `main` and the attestations are untouched. `architecture.md`, `cli.md`, `api.md` and `concepts.md` now say whose review counts.
  3. *Accept interface:* `core.md`'s `accept` row now reads "Vault, actor, approver → merge of the SHA from the approver's own latest review…", and `review`'s row includes the reviewer (`0eedbd2`).
  4. *Process module* (`2ed0663` tests, `4fe2444` implementation): `src/core/process` in L0 is the only importer of `node:child_process`; git, secret commands and scripts run through it. The boundary test allows only `process` (either specifier). `core.md`, `AGENTS.md` and the plan list the module.

### Stage 3b — Work machinery, second half (L2): judgements, notify, templates, forge

- **Commits:** `0689dcd..` on `impl/v1`, after fast-forwarding to `ce1c0ce` — the review finding (`6307136`, `37a7f9a`), the alignment with `ce1c0ce` (`7f82e93`–`e9577f0`), then tests-first and implementation commits for judgements, `notify`, templates and `forge`, two refactor commits (`f4688c3`, `9385833`), the documentation proposal (`a4a6f80`), and this entry as the last commit. As before, each `test(…)` commit fails until the commit after it; every other commit passes.
- **Results:** `npm test`: 497 tests, 497 pass, none skipped. `npm run check`: no errors. `npm run build`: compiles, and all 28 compiled core modules import under plain Node. Node v24.18.0, git 2.55.0, OpenSSL 3.6 (test certificate generated once and committed), Linux.
- **Built:** in `src/core/`:
  - `http` (new, L0) — `requestJson`: the one place a request is made; `redirect: manual`, any 3xx an error with its status; time limit; errors carry a status, never a body. Model clients and forge adapters use it; a boundary test keeps `fetch` and `node:http(s)` inside it.
  - `models` — `askSystemOne` (the judgement role: `POST <url>/systemone`, `bool` as `noul` on the wire, every answer read in full against its question, optional usage).
  - `judgements` — `parseAxes`, `axisVerdict` (each `pass-when`), `judgeDocument`, `judgeProposal`.
  - `notify` — `parseNotifyConfig`, the outbox (`notifySchema`), `sendNotification`, `deliverDue`, `undeliveredNotifications`, `notifyBuiltin`; nodemailer for MIME and SMTP.
  - `templates` — `resolveTemplateSpec`, `inspectTemplate`, `createFromTemplate`.
  - `forge` — one `ForgeAdapter` with Gitea, GitHub and GitLab implementations, `forgeProject`, `protectionProblems`, and `pushToForge`, `proposeToForge`, `publishStatuses` (with `vault/policy`), `syncWithForge`.
  - Aligned with `ce1c0ce`: `conditions` (`actor`; `script` with `narrowByScripts`; `eventJson`), `events` (each change's commit, actor and run, across merges), `attestations` (`mergeAttestations` with cat_sort_uniq; latest by `at`), adopt (moved to `actors`; concerns and acknowledgement), `actors` (`takeActorHold`, `releaseActorHold`, `actorHold`, `listActorHolds`), `process` (`processStartTime` per platform), `queue` (`noChangeSpawn`, `StopReason` with `restart`), `traces` (`no-change` outcome).
  - Additions below L2: `git` (`notesMergeLines`, remotes: `checkRemote`, `fetchCommit`, `fetchRefs`, `pushRefs`, `remoteUrl`; `stageExecutable`, `fastForward`), `documents` (`markdownSections`, `documentTitle`, `utf8Text`), `result` (`canonicalJson`, `isRecord`), `clock` (`parseDuration`), `scripts` (standard input for a run), `policy` (`MergeRequest.approvals`, `RequirementVerdict.failed`, `findControlChanges` from nothing), `config` (forge `api`).
- **Tests:** each module's documented behaviour, local stubs only (HTTP, SMTP with a test CA, forge APIs, bare repositories as remotes), and fail-closed cases:
  - *No redirects:* 301–308 from embed, rerank, judgement and forge endpoints are errors naming the role or forge, and nothing reaches the redirect's target.
  - *Judgements:* the accepted main's axes even when the proposal loosens them; refused during an unaccepted change with nothing sent; no permitted model sends nothing; model errors, content too large (413) and malformed or impossible answers (a missing axis, a wrong type, probabilities over 1, a score outside the levels) fail and record nothing.
  - *Notifications:* raw addresses and unknown aliases refused with nothing queued; text in a subject or body cannot add a recipient or a header; port 587 never authenticates without STARTTLS (a server not offering it gets no AUTH and no MAIL); an untrusted certificate and TLS 1.1 fail before anything is sent; the password is never in the outbox, an error or a record; cooldown, per-hour and size limits; retry as the same Message-ID.
  - *Forge:* only actor branches and notes are pushable, never `main` (four refspecs refused, `main` untouched); proposing is refused during an unaccepted change; `vault/policy` counts only owners' approvals of the exact commit; a GitLab approval without a bindable commit counts for nothing; syncing never discards local commits on `main`.
  - *Templates and remotes:* `ext::`, `fd::`, `http://`, `git://` and option-like remotes refused before git runs; a template with a symbolic link refused and nothing created; an occupied directory refused.
  - *Alignment:* a condition's script runs from the accepted main only, and a missing script, a refusal, a time-out or an unaccepted change drops the match; equally late attestations resolve to the non-pass; adopt refuses an acknowledgement for concerns that have grown; a hold whose holder cannot be checked stands, and a reused process ID holds nothing.
- **Refactoring:** `f4688c3` moved the Markdown section scan and title rule to `documents` so judgements name documents as search does; `9385833` gave `isRecord` and strict UTF-8 text one home each and shared the Gitea/GitHub pull shape, account read and single-pull reading; during the stage, canonical JSON (`axesVersion` and `eventJson`) and duration parsing (budgets and notify) got one home each, and `actorsSchema` moved to its own file. Comments and documents checked against behaviour.
- **Decisions:**
  - *http:* a new L0 module rather than a copy in each client: the no-redirect property is a security property, and a boundary test now enforces one access path (`core.md` lists it; see Needs owner approval).
  - *Judgements:* one request asks every axis in effect for the path; each axis is its own attestation named after it (so `judgement:<axis>` requires it), `subject` the blob, `by` the model ID, `version` the axis's version; state is the purpose summary, path, title, labels and the full file text; axes already judged by the same model under the same version are not asked again; a judgement that cannot be made records nothing (the requirement stays unmet). Probabilities must be within 0–1 and a choice's sum at most 1; `pass-when` compares with a 1e-9 tolerance. A judgement is refused during an unaccepted change, like any check.
  - *Conditions:* `actor` is matched per change, never across vaults; `script` names a vault script, never a built-in (built-ins act), runs in its vault's directory with the event as canonical JSON. `ChangedDocument` carries `commit`, `actor`, `trace`; within a merge, the last ordinary commit it brought that changed the path, a merge commit only as a fallback.
  - *Attestations:* `at` must be `toISOString`-shaped UTC; latest by time, and at equal times a non-pass. Merging uses a separate fetched ref (`refs/notes/vault-forge/*`), merged into ours.
  - *Adopt:* moved to `actors` (policy depends on integrity, so integrity cannot use policy). Concerns are checks on the accepted main whose status is not `pass` (missing included) and control changes; none are computed for checks when nothing was accepted yet. The acknowledgement is a SHA-256 over the starting point, the SHA and the concerns; fewer concerns than acknowledged need none.
  - *Holds:* the process identity is `linux:<boot_id>:<start ticks>`, `darwin:<ps lstart>`, `win32:<start ticks>`; a holder taking its own hold again succeeds; up to three compare-and-swap attempts, then `actor-busy`.
  - *Queue:* `no-change` is a state from `running` only, recorded like the others.
  - *Notify:* the section is validated by `notify` (Stage 4 must call it when the config loads); only ports 465 and 587; defaults `per-hour` 10, `max-bytes` 200000 (body bytes), `cooldown` 12h; dedup by key alone; the outbox keeps the alias, never the address, which is looked up at each attempt; `Message-ID` `<trace.hash(key#n)@from-domain>`; backoff 1m, 5m, 30m, 2h, then 6h; a removed alias makes a message undeliverable. The SMTP stub port and an extra trusted CA are a test seam (`NotifyDeps.smtp`); verification is never off.
  - *Templates:* fetched with `--depth=1` into a scratch repository; files written fresh and one commit made (fresh history); `vault.from-template` is `{ url, commit }`; `init` records the accepted main `by` the person creating it, without an owner check; the marker's `version` is a positive whole number.
  - *Remotes:* https, ssh (also scp-like) and local paths only, enforced by `checkRemote` and git's protocol allow-list, with `fetch.fsckObjects`.
  - *Forge:* the remote is `origin`; the forge is found by host name (ports ignored); API bases default per type, `api` overrides; a forge's `vault/policy` is `success` when satisfied, `failure` when something failed, else `pending`; check statuses `vault/check/<name>`; approvals by owners for the head only; the executor's forge account is recorded as `by` for `sync`; sync moves local `main` only forward and leaves it when its checkout has uncommitted changes. GitHub "direct pushes" means no required reviews; Gitea branches cannot be deleted while protected.
- **Needs owner approval:**
  1. `a4a6f80` — formats implemented against: `builtin:notify` outcomes and exit statuses, sendmail `command`/`args`, ports 465/587 only, limit defaults, backoff and undeliverable messages, the `Message-ID` ordinal; forge pushes to `origin`, `vault/check/<name>`, owners' approvals of the exact commit; templates only over https, ssh or local paths, links refused; GitLab's setup caveats; no judgement cache in `state.sqlite`.
  2. Made in the same commits as the code, as accuracy additions, but worth a look: the `http` module in `core.md` (`37a7f9a`); adopt's home and interface in `core.md` (`a5edf3d`); how judgements are recorded in `core.md` (`9db5558`); the attestation tie rule in `concepts.md` (`937c114`); the optional forge `api` key (`48abd92`).
  3. Owner decisions on `c479714` (Stage 3a review) are recorded as given: policy stays an allow list (Stage 4's `vault doctor` must say when search is keyword-only because no entry names the vault); no cascade-pool; the queue-time limit stays a parameter (a config key to be proposed in Stage 6).
- **Gaps:**
  - Daemon-side pieces of `ce1c0ce`, for Stage 6: one job per actor in the scheduler (spawns do not yet record their actor), start-up recovery (stopping running spawns with `restart`, ending recorded processes, resetting worktrees), chain continuation when matching (choosing the session tree from the matched changes' traces), timer identity by local date and slot, the daemon singleton, outbox retry scheduling, forge sync scheduling. Stage 4: `vault doctor` checks (holds, `core.hooksPath`, remotes on local vaults, Git locks, protection problems, undelivered notifications), validating `notify` when the config loads, `vault init` registering the vault. Stage 5: the extension taking and releasing holds, and handing jobs `eventJson`.
  - `commitAsActor` does not check the hold; the hold is taken by sessions and the scheduler.
  - Check runner: nothing runs `.vault/checks/` yet (adopt reports unpassed checks; it does not run them).
  - Forge APIs: request and response shapes follow each forge's documentation (Gitea's 1.24 schema and GitLab's API pages were checked; GitHub from its well-known API); tested against stubs only, never a live forge. GitLab Premium settings (approvals, approval rules) read as unavailable on lower tiers. A template's submodules are skipped silently (only blobs are listed).
  - Process identity: Linux tested for real; macOS and Windows through injected answers only.
  - Real-time waits added: a 100 ms script time-out in the condition-script tests; SMTP and forge tests use local sockets with a 5 s limit.
  - As before, Node 22.18 and git 2.36 (the declared minimums) are untested; Windows and macOS are untested on real machines.
- **Review findings addressed:**
  1. *Fast-forward to `design/stress-test`:* done (`ce1c0ce`); read before continuing.
  2. *Owner decisions on `c479714`:* recorded under Needs owner approval (3) and Gaps.
  3. *Redirects:* tests first (`6307136`), then `37a7f9a`: requests go through `http` with `redirect: manual`; a redirect is `{ reason: 'redirected', role, status }`. Applies to embed, rerank and judgement, and to forge requests (as `forge` instead of `role`).
  4. *Judgement API:* implemented to `core.md` "Judgements" and `concepts.md` "Judgement axes"; Pi's `system-one-shared.js` was read for the wire shapes only, nothing imported.
  5. *Alignment with `ce1c0ce`:* conditions (`fb446aa`), events (`fb446aa`), attestations (`937c114`), adopt (`a5edf3d`), holds (`1631db0`), queue (`e9577f0`), each with its tests first; daemon-side pieces listed under Gaps.
  6. *Stage 3b:* as above.


### Stage 4 — Operations and CLI (L3, L4 CLI)

- **Commits:** `767159c..` on `impl/v1` — the Stage 3b review findings (`767159c`–`09f0dd1`), then tests-first and implementation commits for Stage 4 (`8fce09c`–`f54d1a2`), the documentation changes (`4e36c47`), the refactoring pass (`9349956`, with `34a0190`, `e158cb6` and `c27cfb8` during the stage), a fix found in it (`3023d1a`, `6e2af75`), further operation tests (`60284be`, `858295a`), and this entry as the last commit. As before, each `test(…)` commit for new behaviour fails until the commit after it; every other commit passes.
- **Results:** `npm test`: 594 tests, 594 pass, none skipped on Linux. `npm run check`: no errors. `npm run build`: compiles; all 28 compiled core modules and the CLI import under plain Node, and `node dist/cli/main.js` runs (`--help` exits 0, an unknown command 2). Node v24.18.0, git 2.55.0, Linux.
- **Built:**
  - Review findings: `process` — existence first (`systemProcessProbe.exists`, signal 0), Windows PowerShell by absolute path with its variables; `actors` — `listActorHolds` says whether a hold stands because its holder runs or cannot be told; `commitAsActor` refuses while another hold stands; `forge` — GitHub protection from branch protection and ruleset rules; `POLICY_CONTEXT` in `adapter.ts`.
  - L0–L2 additions: `config.registerVault`; `git` — `prepareCommit`, `landCommit` (`createCommit` is the two), `exportTree`, `configValue`, `listRemotes`, `gitDirectories`; `scripts.runChecks`, `recordCheckResults`; `actors` — blocking checks in `commitAsActor`, `syncActorBranch`, `heldByAnother`, `worktreeFile`; `registry.writersOf`; `conditions.documentConditions`; `queue.vaultJobs`; `notify.testTransport`; `templates.createEmptyVault`; the external event's `payload`.
  - `operations` (L3): `permissions.ts` (`PERMISSIONS`, groups, `parseMcpConfig`, `effectivePermissions`, `mayCall`, `permittedOperations`); `installation.ts` (`loadInstallation`); `context.ts`; `types.ts`; `catalogue.ts` (`CATALOGUE`, `checkParams`, `chooseVaults`, `placeVaultPaths`, `runOperation`); `messages.ts`; `notices.ts`; `locate.ts`; the operations in `ops/` — search, read, contract, reindex; status, review, accept (and adopt), sync, propose, commit, write; jobs, run, trigger, script, notify, trace; list, add, init, whoami, template show, doctor.
  - CLI (L4): `src/cli/args.ts` (flags and positionals from the specs), `run.ts` (`runCli`), `main.ts`.
- **Tests:** each operation against a temporary installation (own config and state directories, a temporary vault), the CLI in-process and once as a real process, a forge-mode propose and sync against a stub forge and a bare repository. Fail-closed cases:
  - *Holds:* a vanished holder never stands on any platform, even where its start time cannot be asked; `cannot-tell` only for an existing process, which doctor reports with process and session; a commit, a sync and a write are refused while another session holds the actor, and a commit never takes a hold.
  - *Checks:* only the accepted main's checks run, at their accepted version (a check added or loosened on a branch does not count); refused during an unaccepted change with nothing run; a time-out, an interpreter that cannot start or an invalid check is `error`, never a pass; a failing check leaves nothing landed and the changes in place; a commit during an unaccepted change is refused.
  - *Permissions:* no permission implies another; nothing without an `mcp` section or permissions; unknown operations, groups and vaults, mixed list edits and literal tokens refused at load without repeating values; `accept` needs an owner; an HTTP endpoint needs a token; a model is offered no parameter choosing whom it writes as; judgements and acceptance are no tools.
  - *Operations:* parameters checked strictly (unknown, kind, required, choices); adopt records nothing until the concerns are acknowledged and confirmed; accept refuses a non-owner and an unreviewed proposal; write refuses `..`, absolute paths, `.git` in any case, and a path through a link out of the worktree, with nothing made outside; run and trigger queue nothing for a vault with an unaccepted change; reindex refused then, and unaccepted content never searchable; status over MCP shows no outbox, trace over MCP no full logs; scripts get no secret from the environment; notify refuses raw addresses and unknown aliases.
  - *Doctor:* `core.hooksPath`, a remote on a local vault, an index lock in main's worktree, keyword-only search, no daily ceiling, notify unconfigured, permissions; `--fix` installs a pre-push guard that refuses a push of main (run as a real hook) and never replaces the user's own hook.
- **Refactoring:** `34a0190` one alias lookup in notify; `e158cb6` one home for making a new vault (`newVault`, `checkNewVault`); `c27cfb8` `remoteUrl` through `configValue`; `09f0dd1` one home for `vault/policy`; `9349956` one home each for the hold check (three copies), the writers list, the worktree file guard (moved from operations to actors, for the extension), what a job is (moved to queue, for the daemon) and vault paths (moved from the CLI to operations, for Pi and MCP); an unused helper removed. Comments, module headers and `core.md` checked against behaviour.
- **Decisions:**
  - *Holds:* signal 0 decides existence (ESRCH ended, EPERM exists); any other answer still asks for the start time. PowerShell gets `SystemRoot`, `windir`, `SystemDrive`, `TEMP`, `TMP`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `ProgramData`; without `SystemRoot`, `cannot-tell`.
  - *GitHub:* every request and response shape was checked against GitHub's REST description (github/rest-api-description); they were as documented. Rules from `GET /repos/{o}/{r}/rules/branches/{branch}` (active rulesets only, any level): `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks` count; other rule types do not bear on who can change main. Reviews were already paged (`per_page` 100, `page`); a review by a deleted account (user null) counts for nothing. The 140-character status cap is not documented by GitHub.
  - *Checks:* run as specified in `concepts.md` (`4e36c47`); every check on the accepted main is blocking; a check's time limit is the script limit, 5 minutes; evidence is the first output line, up to 500 characters. A commit is prepared on no branch, assessed, and landed by compare-and-swap; only a landed commit's verdicts are recorded. Checks are a script run, so they are refused during an unaccepted change, and so is a commit.
  - *Sync:* moves a branch without work forward; otherwise merges the accepted main in the actor's worktree with the package's trailers and records the checks' verdicts, failing ones too (the merge exists). Uncommitted changes leave the branch alone.
  - *Conditions:* a document's conditions are its own, then its contract's (union, so its own keep their positions); a contract that cannot be read leaves its documents with none, and says why.
  - *Installation:* no config file is an installation with no vaults. `mcp`: `listen` optional (standard I/O only), `host:port` needs a token, an absolute path is a socket or pipe; each profile holds every registered vault's effective set.
  - *Catalogue:* every operation the CLI offers is in the catalogue (installation ones too, CLI-only), except `daemon …` and `mcp`, which control processes and arrive with the daemon; `template show` is the operation `template-show`. Pi tools and commands are those in `api.md`.
  - *Callers:* owner acts are the caller's person (CLI: `installation.person`; MCP: the profile's `owner`); writes are made as the caller's actor (the actor worktree the CLI runs in, else `--actor`, else the person); over MCP, `write` and `commit` take the actor (`mcp.md`, `4e36c47`).
  - *Read:* content as on the accepted main; freshness against main itself (`current`, `changed`, `gone`). `search` only reads the index; `reindex` updates it.
  - *Run and trigger:* claim spawns for the daemon; a manual run's event ID is a new trace ID; an external event reaches its vault and those the installation subscribes to it; a payload is JSON of at most 64 KiB; a job without a readable budget cannot spawn.
  - *Scripts:* the environment is only what interpreters need (`PATH`, `HOME`, locale, temporary directories; on Windows the system variables); a script works in the caller's place in the vault, else the vault's checkout.
  - *Identity:* package commits and notes are made as `<name>@<host of the installation name>`.
  - *Init:* an empty vault's root contract names its id, the person as owner and audience, `purpose.summary: The <id> vault.`, no actors, and `merge: [{ paths: ["**"], require: [checks, owner] }]`. `add` takes the id from the root contract at main's tip and accepts nothing.
  - *Doctor:* model roles' tokens are resolved; endpoints are not contacted (that would spend tokens). The pre-push guard refuses any push updating `refs/heads/main`; `--fix` installs it only where no hook is. A problem exits 1. The daemon's absence is a warning.
  - *CLI:* a first positional naming a registered vault is the vault when what remains still fills the command; a passthrough list (script arguments) takes options as given; usage errors exit 2; success output to standard output, everything else to standard error; `--json` prints `{ status, data, text, notices }`. Adopting asks at a terminal (`confirm`), and otherwise exits 2 with how to confirm.
  - *Notify test:* `--to` is required; one fixed message is delivered directly, not queued.
  - *Jobs:* "next run" is not shown yet: timers, their library and their local-date-and-slot identity belong to Stage 6 (the newest `croner` was published a day ago; choosing a version and checking its daylight-saving behaviour against `daemon.md` is that stage's work).
- **Needs owner approval:**
  1. `4e36c47` — documentation of behaviour built here: the check protocol and the Git identity of package commits (`concepts.md`); checks pause with automation, so commits wait during an unaccepted change (`security.md` — a narrowing of "interactive work continues"); `cli.md` as built (init's empty vault, `add` unaccepted, doctor's added checks and exit status, adopt without a terminal, `--actor`, script options passing through, `notify test --to`, exit 2 for usage errors, `--json` on every command); `mcp.md` (reviews are the profile owner's; `write` and `commit` name their actor); `notifications.md` (`notify test`).
  2. `d7cdd07` — review finding 3, as asked.
  3. Doctor resolving model tokens without contacting endpoints (cli.md now says "model endpoints' tokens").
- **Gaps:**
  - Stage 6: `vault daemon …` and `vault mcp` say they need the daemon and exit 1; `run` and `trigger` only claim spawns; `jobs` shows no next run; doctor's start-up recovery under `--fix`, the `reference-transaction` hook and the daemon-service check; the MCP adapter must require a vault for `optional`-scope operations (`notify`) when it checks `mayCall`.
  - GitHub ruleset bypass actors are not read: an executor on a ruleset's bypass list would pass doctor (`current_user_can_bypass` on `GET /repos/{o}/{r}/rulesets/{id}` could tell).
  - `exportTree` uses `checkout-index`, so a repository-configured smudge filter would run when checks export a commit.
  - Registering a vault keeps comments and order, but the YAML library normalises the spacing before an inline comment.
  - The installed `pi` here reports 0.82.1, below the 1.3 the design targets; doctor would report it. To look at before Stage 5.
  - Windows: signal-0 existence through Node, PowerShell's start, check scripts, the pre-push hook and file modes are untested on a real machine; macOS likewise. The terminal prompt is tested through an injected `confirm` only.
  - Real-time waits added: a 200 ms check time-out; a 300 ms SMTP time-out in the transport test.
  - As before, Node 22.18 and git 2.36 (the declared minimums) are untested.
- **Review findings addressed:**
  1. *Holds on Windows:* tests first (`767159c`), then `396f92a`: existence by `process.kill(pid, 0)` first (ESRCH: the hold is void, nothing asked; EPERM: it exists); only then the start time, on Windows by `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` with the variables it needs. Through the probe on all three platforms, a vanished process never leaves a standing hold; `cannot-tell` describes only an existing process, and `vault doctor` reports such holds with process ID and session.
  2. *Commit while held:* tests first (`6cb57ef`), then `8c16254`: `commitAsActor` refuses while another standing hold exists; it checks and never takes one.
  3. *concepts.md judgements:* `d7cdd07` — `judgement:<axis>`, each axis recorded on its own, an axis that cannot be judged records nothing.
  4. *GitHub adapter:* verified against GitHub's REST description; tests first (`7c0b59d`), then `09f0dd1`: rulesets read, so a ruleset-protected main is not reported unprotected; reviews read across pages (already so, now tested); a deleted account's review counts for nothing.

### Stage 5 — Pi extension (L3 sessions, L4 extension)

- **Commits:** `0679c8e..` on `impl/v1` — the Stage 4 review findings (`0679c8e`–`5751368`), then tests-first and implementation commits for Stage 5 (`1289514`–`7a405c2`), the documentation (`d88183f`), the refactoring pass (`2e73090`, with `efc4f83`, `065aaf5`, `deed9e3` and `a725fa3` during the stage), and this entry as the last commit. As before, each `test(…)` commit for new behaviour fails until the commit after it; every other commit passes.
- **Results:** `npm test`: 698 tests, 698 pass, none skipped on Linux. `npm run check`: no errors. `npm run build`: compiles; the compiled extension (`dist/extension/index.js`) imports under plain Node with its default factory and `createExtension`. Node v24.18.0, git 2.55.0, Pi 1.3.0 (the dev dependency; the global `pi` was not used), Linux.
- **Built:**
  - Review findings: an `invalid` outcome status for a request that does not fit (parameters failing their specs, a query with no words, a payload that is not JSON, a malformed trace ID, no actor to accept); the CLI exits 0 / 1 / 2 (`invalid`) / 3 (`refused`); `cli.md` says so. `mcp.md` and `concepts.md`: MCP writes only as one of the vault's `actors`, and every MCP commit carries `Vault-Tainted`.
  - `sessions` (new, L3): the run file (`parseRunContext`, `renderRunContext`); `openSession` / `holdActor` / `closeSession` / `callerOf` — actor (worktree, `--vault-actor`, else the person), hold, trace and budget, a headless run's brief (its job as on the accepted main, the event as canonical JSON); `guardToolCall`; `taints`; `injectionsFor` / `renderInjections`; `sessionEvent`; `recordTurn`, `workLeft`; `catalogText`.
  - Below the adapter: `operations` — `commandline.ts` (`parseLine`, `splitArguments`, `commandRequest`, `describeCommandLineError`, moved from the CLI), `callRequest`, `results.ts` (`modelResult`, `outcomeData`), `spawning.ts` (`requestSpawns`, `spawnLines`, `queueContext`), `OperationOutcome.confirm`, `Caller.trace`; a commit requests what its own `committed` event spawns; commit's `paths` are vault paths. `queue` — `matchSpawns`, `submitSpawns`, `reachedVaults` (from `trigger`). `config` — `realLocation`, `landsWithin`, `launcherFor`, `writeLauncher`. `budgets.usageOf`; `git.isGitProgram`; `conditions.isGitEvent`; `eventJson` for any spawn event.
  - The extension (`src/extension/`): `index.ts` (`createExtension`, flags), `tools.ts` (tools from the catalogue), `fan-out.ts`, `commands.ts` (`/vault`, `install-cli`), `hooks.ts`, `bus.ts`, `operate.ts`, `paths.ts`, `live.ts`.
  - Test support: `test/support/pi.ts` (in-memory SDK sessions with a faux model, a recording UI, the event bus and tool results observed), `test/support/session.ts`.
- **Tests:** the core `sessions` module on its own, and the extension end to end through Pi 1.3.0's SDK. Fail-closed cases:
  - *Holds:* a busy actor is reported with its holder and writes to its worktree are blocked until it is free; a session whose own process cannot be told holds nothing; the hold is released at shutdown.
  - *Headless runs:* an unreadable or invalid run file, an unknown vault, no allotment, no job on the accepted main, an actor that is no writer or is held — each refuses the run, which shuts down; a run past its budget, run time or the daily ceiling is stopped (`pav:v1:spawn` with the reason); it writes nothing outside its worktree; it fans out no further than its budget.
  - *Write guard:* the checkout (with where to write instead), another actor's worktree, `.git` in any case, a link out of the worktree, and — headless — anywhere outside it, are blocked; `git push` anywhere, `git -C <checkout> commit`, `cd <checkout> && git merge`, reset/commit/pull in the checkout, `update-ref`/`branch -f`/`checkout -B` on main are blocked; `echo "git push"` and Git work in the worktree are not.
  - *Taint:* an untrusted tool, no trusted list, and a read outside the vaults (a sibling directory too) taint; the commit then carries `Vault-Tainted`.
  - *Accepted main only:* injected contracts and documents, a run's brief and the catalog come from the accepted main, never an unaccepted change; a vault with an unaccepted change spawns nothing and says it is paused.
  - *Spawn identity:* a request the daemon claimed with a lost reply is still one spawn; a session event spawns once; a commit's spawns join its session's tree, or a new one outside a session.
  - *Surfaces:* tool declarations carry no runtime values and offer no `actor`; a confirmation never reaches a model; nothing that writes or acts as an owner is offered on the event bus; adopting via `/vault` is recorded only when the person confirms; the launcher never replaces a `vault` that is not its own, and quotes its path.
- **Refactoring:** `efc4f83` command-line reading moved to `operations` for the CLI and `/vault`; `065aaf5` one place says where a path lands (`locate`, `worktreeFile` and the worktree comparison each had a copy; `locate` also took `..foo` for outside); `ff53847` matching spawns moved out of `trigger`; `deed9e3` an outcome awaiting confirmation says so (the CLI cut the outcome's text to find what to show); `a725fa3` and `e194aa0` one way to turn a command line or named arguments into a request; `2e73090` one `requestSpawns` for trigger, commits and session events, the seen-key is `spawnEventKey`, shared extension test helpers, stale headers. Comments, module headers and `core.md` checked against behaviour.
- **Decisions:**
  - *Exit statuses:* adopting without a terminal, and declining at one, exit 3 (refused: not confirmed). A request that does not fit the operation is `invalid` (exit 2), on every surface.
  - *Actor:* the worktree's actor wins over `--vault-actor`; outside every vault a session writes as no actor; an actor that is not a writer, or a vault with nothing accepted, leaves the session without a worktree, with a notice. The worktree is made at session start (so Pi's own `write` lands in a Git worktree, never a plain directory).
  - *Interactive budget:* the session is the root of its own tree with an allotment of `Number.MAX_SAFE_INTEGER` tokens (capped by the daily ceiling) and no run time; its turns count towards the day; it is never stopped. Without a budget today, a notice says its spawns cannot run.
  - *Usage:* Pi's `input` + `cacheRead` + `cacheWrite` are the prompt, `cacheRead` the cached prefix, `output` generated (Pi's `totalTokens` is their sum); a turn's record is the assistant message's usage plus its tool results' (nested calls, such as fan-out's), as one transaction; compaction is recorded the same way.
  - *Session events:* the start, each tool and each vault path are counted once per session; their IDs are the session ID, `<session>/<tool>` and `<session>/<path>`; session-wide events reach every vault. Pi's file tools' paths (read, edit, write, grep, find, ls) and vault tools' vault paths are touched paths.
  - *Injection:* appended to the result of the call that touched the path (`tool_result`), as `<vault-context source="…">` blocks; start documents, notices and a run's brief go into one hidden custom message (`pav:context`) before the next request. The catalog is the system-prompt section `vault-catalog`, read from accepted mains; a vault with nothing accepted, or unreadable, is listed as not available.
  - *Guard:* applies to Pi's `write`, `edit`, `bash` and `powershell`; paths read as Pi 1.3's `resolveToCwd` reads them (it is not exported, so `paths.ts` mirrors it).
  - *Commits:* a session's commits carry its trace; a commit requests what its `committed` event spawns right away, on every surface.
  - *Commands:* output is a displayed `pav:vault` custom message (not sent on its own); owner acts are the installation's person's.
  - *Fan-out:* item and gather sessions are single model requests with no tools through `ctx.modelRegistry.complete`; a failed item is reported and the rest gathered; usage is reported with the tool result.
  - *Bus:* replies are `{ ok, status, data, text, notices }` or `{ ok: false, error }`; `ready` also carries the session's trace.
  - *Launcher:* `%LOCALAPPDATA%\Microsoft\WindowsApps\vault.cmd` on Windows (a per-user directory on PATH by default); it runs `node` from PATH.
- **Needs owner approval:**
  1. `d88183f` — documentation of the extension as built (the decisions above that change what a reader would expect: injection with the call's result, the guard's scope, session events counted once, the run file's keys, `vault_jobs` taking `vaults`, command output, bus payloads, the Windows launcher).
  2. *Which actor a job runs as* is not documented: the run file carries it, and the daemon (Stage 6) must choose it. A proposal is needed before Stage 6 — for example an `actor` key in a job document's frontmatter, defaulting to the first of the vault's `actors`.
  3. *`builtin:notify` exit statuses* (`notifications.md`): a refusal exits 1 and a usage error 2, while the CLI now refuses with 3. Say whether it should follow.
  4. Approved in the Stage 4 review and recorded: commits wait during an unaccepted change; the check protocol; `<name>@<host>` identity; an empty vault needing checks and an owner; doctor not contacting endpoints.
- **Gaps:**
  - Stage 6: the daemon link — sending spawn requests (`SpawnSender`), "connects to the daemon if one is running", and the start/finish notices of spawned work; running headless sessions as `pi --mode rpc` (here only through the SDK, with RPC-mode bindings); choosing a job's actor; MCP `write` and `commit` only as one of the vault's `actors`, every MCP commit tainted, `modelResult` for MCP tools, and `optional`-scope operations needing a vault; `croner` (or another cron library) only in a release at least two weeks old.
  - Trace capture: the extension does not yet record results for full logs or write the compact trace at shutdown (the design keeps both; the full-log and compact-trace writers exist in `traces`).
  - Session events match a vault's jobs afresh from Git for each new event (injection caches documents per session; spawn matching does not); untested at scale.
  - The guard reads shell commands as words: it does not follow `--git-dir`/`--work-tree`, scripts a command starts, or aliases; PowerShell is read with the same separators and `cd`/`Set-Location`. Only Pi's built-in file tools are guarded and taint-checked by path.
  - `paths.ts` mirrors Pi 1.3's path reading; its Windows branch is untested, as are the launcher's Windows write (tested as a pure function), Windows file modes and macOS generally.
  - The global `pi` on this machine is 0.82.1, the owner's to upgrade; tests use the 1.3.0 dev dependency.
  - As before, Node 22.18 and git 2.36 (the declared minimums) are untested.
- **Review findings addressed:**
  1. *Exit statuses:* tests first (`0679c8e`, `c200baf`), then `32ade84`: 0 success, 1 failure, 2 usage error, 3 refused by policy or a guard, in the CLI and `cli.md`.
  2. *MCP writes:* `5751368` — `mcp.md` says `write` and `commit` write only as one of the vault's `actors`, never an owner, and that every MCP commit carries `Vault-Tainted`; `concepts.md` "Actor" too. Both are listed under Gaps for Stage 6.
  3. *Notes:* the global Pi is left alone and Stage 5 tests use the 1.3.0 dev dependency; the cron-library age rule is recorded for Stage 6.
  4. *Stage 5 gaps:* holds taken at session start and released at shutdown; a headless job handed the triggering event as data (`eventJson`, in its brief); spawn identity fixed before sending or queueing (`submitSpawns`); per-turn budget records (`recordTurn`).
