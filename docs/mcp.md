# MCP

Vault operations are available to any MCP client — chat front-ends, other
agents, editors — through **profiles**. A profile is a set of permitted
operations, with optional per-vault overrides. The daemon serves each profile
on its own endpoint; `vault mcp --profile <name>` serves one over standard
input/output for local clients that start their own servers.

MCP tools, Pi tools and CLI commands are generated from one catalogue of
operations in the core, so the surfaces never drift apart.

## Permissions

A permission is the name of an operation. A profile's permissions are a plain
set — no permission implies another.

| Operation | Does |
|---|---|
| `search`, `read`, `contract`, `jobs`, `status`, `trace` | Read vault content and state |
| `write`, `commit`, `propose` | Change documents in an actor worktree; commit; push a proposal (`forge` mode) |
| `run`, `trigger`, `script`, `notify` | Run a job; emit an external event; run a script; send a notification |
| `review`, `accept`, `reindex` | Review proposals; accept as an owner; rebuild the index |

Named groups are shorthand that expand to sets: `@read` (the first row),
`@propose` (the second), `@run` (the third), `@admin` (the fourth). Groups and
operation names can be mixed freely.

## Profiles and layering

```yaml
mcp:
  profiles:
    - name: chat
      listen: 127.0.0.1:8735          # loopback by default; or a socket / named-pipe path
      token: ${VAULT_MCP_CHAT}
      permissions: ["@read"]          # the base set for every registered vault
      vaults:
        private: []                   # nothing at all for this vault
    - name: editor
      listen: 127.0.0.1:8736
      token: ${VAULT_MCP_EDITOR}
      permissions: ["@read", "@propose"]
      vaults:
        home-knowledge: [+review, -propose]
      owner: alice                    # approvals through this profile are alice's
```

For each vault, a profile's effective permissions are:

1. its `permissions` — the base set, empty if not given;
2. replaced or edited by the vault's entry, using the contract list syntax: a
   plain list replaces the set, `+x` adds, `-x` removes.

With no `mcp` section, or a profile with no permissions, MCP can touch nothing.

## Rules

- **One token per endpoint.** Each HTTP endpoint requires a bearer token (from
  `${ENV}` or `!command`); there is no anonymous access and no per-client
  identity within an endpoint. A socket or named-pipe endpoint is protected by
  being accessible only to the user instead. Standard-I/O servers trust the process that started them.
- **Loopback by default.** Endpoints do not terminate TLS; expose one beyond the
  machine only through a reverse proxy that does.
- **Accept needs an owner.** `accept` works only on a profile that declares an
  `owner`, and the approval attestation records both the owner and the profile.
  Reviews through a profile are its owner's too.
- **Writes name their actor.** `write` and `commit` take the actor to write as —
  one of the vault's actors or owners — and are refused while another session
  holds it.
- **Only listed tools exist.** A client sees exactly the operations its profile
  permits for at least one vault, in a stable order; calls for a vault where
  the operation is not permitted are refused.
- **Same behaviour everywhere.** An operation over MCP enforces exactly what it
  enforces in Pi or the CLI — merge policy, write guards, scripts from the
  accepted `main` — and every response for a vault with an unaccepted change
  carries the same notice.
- **One daemon per installation.** Different permission sets are separate
  profiles, not separate daemons: the daemon also owns scheduling, which must
  not run twice. `vault mcp` processes only run operations, so any number can
  run alongside it.
