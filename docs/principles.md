# Principles

Every part of the package follows these. A design or code change that conflicts
with one needs the principle changed first, deliberately.

## Knowledge and control

1. **Git is the source of truth and the protocol.** Vault content, history,
   proposals and review state live in Git. A forge (Gitea, GitHub, GitLab) is
   an optional view; everything works with a local repository alone.

2. **Everything is a document.** Knowledge, jobs, policies and memories are
   Markdown files with YAML frontmatter. Frontmatter is what the package
   enforces; prose is what people and agents read.

3. **Owners control `main`.** Changes reach `main` only by satisfying the
   vault's merge policy. Policy is data in the vault, it is evaluated against
   the exact commit under review, and only owners can change it.

4. **Agents propose; infrastructure judges.** Agents write to their own
   branches. Checks, judgements and approvals are produced by the package or by
   people — never by the agent whose work is being assessed.

5. **Content is data, never instructions.** Text inside a vault, a fetched page
   or a tool result is material to work on. Only job documents and contracts
   on the accepted `main` instruct agents.

## Execution

6. **Exact work goes through approved scripts.** Anything that must be
   repeatable — finding files, naming, dates, search, delivery — is a script:
   the vault's own in `.vault/scripts/`, run only from the **accepted `main`**
   (the commit an owner last accepted), or one of the package's built-ins.

7. **Work is bounded.** Every spawned session has a token and time budget.
   Budgets only shrink as work branches; triggered work draws from a separate,
   bounded pool.

8. **Work is traceable.** Every run gets a unique trace ID. A compact trace is
   kept in the vault; full detail is kept locally for a limited time.

9. **Gates fail closed.** A check, judgement or guard that cannot reach a
   verdict blocks, or routes to a person — it never passes.

## Configuration and access

10. **No models are built in.** Models are named entries in the installation
    config, each with a role. Documents ask for a model by name, never by
    what it is; each role has a default entry named after it, which answers
    when a requested name is not configured. A missing default disables its
    feature visibly; it never causes an error.

11. **Access control is Git's job.** Whoever can clone a vault can read all of
    it. The package does not pretend to enforce anything beyond that.
    Installation configuration records the policies a consumer has agreed to;
    it binds only the machine it is on.

12. **Vaults are independent; the installation composes them.** A vault never
    refers to another vault. Cross-vault behaviour — shared labels, permitted
    triggers — is declared by the installation.

13. **No layout is imposed beyond the package's own formats.** The only
    reserved names are `_contract.md` and `.vault/`. Every other path is the
    vault's or the user's choice.

## Construction

14. **A small orthogonal core.** New capabilities are composed from existing
    concepts first. A new core concept needs a reason the existing ones cannot
    serve.

15. **Loosely coupled, gracefully degrading.** The CLI, extension and daemon
    each work without the others wherever possible. Missing pieces reduce
    capability; they do not cause failure.

16. **Stable by construction.** Tool lists, prompts and injected context are
    ordered deterministically and change only at session boundaries, so model
    prompt caches stay effective.

17. **Standard interfaces, one definition.** Capabilities are exposed as Pi
    tools, commands and events, CLI commands and MCP tools — all generated from
    one catalogue of operations, so they behave identically and other software
    can build on them.

18. **Exposure is explicit and narrow.** Every interface beyond the local user
    is off until configured, and grants only the operations configured for it,
    vault by vault.

19. **Portable.** Linux, macOS and Windows are equally supported. Paths,
    services, sockets and script execution use each platform's own
    conventions.
