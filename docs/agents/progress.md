# Progress log

Maintained by the implementing agent; read by the reviewer. Newest stage last.

**Branch:** `impl/v1`
**Current stage:** 3b — complete, awaiting review

## Current stage status

Kept current with every commit, so an interrupted session can resume.

- **Done:** Stage 3 (3a and 3b): the work machinery, with the Stage 3a
  review findings and the alignment with `ce1c0ce`; see the Stage 3b entry.
- **In progress:** nothing.
- **Next:** review of Stage 3b. Then, when told, Stage 4 (operations and CLI).

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

