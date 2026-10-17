# Progress log

Maintained by the implementing agent; read by the reviewer. Newest stage last.

**Branch:** `impl/v1`
**Current stage:** 0 — complete, awaiting review

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
