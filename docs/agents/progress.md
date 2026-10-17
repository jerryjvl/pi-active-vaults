# Progress log

Maintained by the implementing agent; read by the reviewer. Newest stage last.

**Branch:** `impl/v1`
**Current stage:** 3a — traces, budgets, queue, models and search (the first half of Stage 3)

## Current stage status

Kept current with every commit, so an interrupted session can resume.

- **Scope of this session:** the Stage 2 review findings (1)–(4), then Stage 3a
  only: `traces`, `budgets`, `queue`, `models`, `search`, tests first,
  a refactoring pass, and a checkpoint. Judgements, `notify`, `templates` and
  `forge` are for the next session.
- **Done:** findings (1)–(4): documentation, accept bound to the approver's
  own review, the `process` module with git, secret commands and scripts on it.
- **In progress:** Stage 3a. Done: `sqlite-vec` dependency, `traces`.
- **Next:** `budgets`, `queue`, `models`, `search` — each tests first, then
  implementation; then the refactoring pass and the entry.

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
