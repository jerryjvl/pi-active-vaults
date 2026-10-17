# Progress log

Maintained by the implementing agent; read by the reviewer. Newest stage last.

**Branch:** `impl/v1`
**Current stage:** 2 — Vault model (L1), in progress

## Current stage status

Kept current with every commit, so an interrupted session can resume.

- **Done:** Stage 1 review findings 1–4 (`main` merged `d8217ac`, trailers in
  the repository's directory, `prepack` build, per-module schema ownership with
  `operations/stores.ts` assembling the lists). Stage 2: documentation
  proposal `4efd656` (implemented against; needs owner approval); `git`
  additions (tree listing, merge base, first-parent history, text and
  path-type reads); shared `DataReader`; `conditions`; `contracts`; `registry`; `events`; `attestations`; `integrity`
  (+ `test/support/vault.ts`); `scripts`; `policy`; `actors`. All Stage 2
  modules are implemented.
- **In progress:** the refactoring and consolidation pass (first commit: one
  committed-document reader, narrower exports).
- **Next:** the Stage 2 refactoring pass and the whole-codebase
  consolidation pass (implementation-plan.md "Refactoring passes"), then the
  Stage 2 progress entry and checkpoint.

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
