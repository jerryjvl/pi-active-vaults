@AGENTS.md

# Claude-specific notes

## Key documents

- [Implementation plan](docs/agents/implementation-plan.md) and
  [progress log](docs/agents/progress.md) — how the work proceeds
- [Principles](docs/principles.md) — the constraints on every decision
- [Security model](docs/security.md) — guarantees every component preserves
- [Concepts](docs/concepts.md) — the model and file formats
- [Architecture](docs/architecture.md) — how the parts fit
- [Components](docs/components/) — core, CLI, extension, daemon
- [Pi API surface](docs/api.md) and [Pi conventions](docs/pi-conventions.md)
- [MCP](docs/mcp.md) and [Notifications](docs/notifications.md)

## How to work here

- **Hold to the principles.** The most important for implementation:
  - all logic in `src/core/`, adapters stay thin;
  - nothing hardcoded — models, URLs and paths come from configuration;
  - only the accepted `main`'s scripts and jobs run, and accept merges only the
    reviewed SHA;
  - gates fail closed, and agents never judge their own work.
- **Keep iterating on design quality.** After each change, look again for
  duplication, misplaced logic and stale comments, and fix them. Prefer
  generalising an existing function over adding a near-copy.
- **Comment the why.** Module headers state responsibility and invariants;
  non-obvious and security-relevant decisions are explained where they are made.
- **Verify, don't recall.** Check Pi APIs against the installed Pi's own docs
  before using them, and say when something is unverified.
- **Compose before extending.** If a feature seems to need a new concept, first
  show how existing concepts could express it, and raise it with the owner.
- **Keep human docs concise.** Update them in the same change as the behaviour
  they describe.
