# MCP

Vault operations are available to any MCP client — chat front-ends, other
agents, editors — through **profiles**. A profile is a set of permitted
operations, with optional per-vault overrides. The daemon serves each profile
that has a `listen` endpoint over HTTP at `/mcp` (stateless: each request
stands alone), and profiles may share an endpoint, chosen by path (see
[Sharing an endpoint](#sharing-an-endpoint)); `vault mcp --profile <name>`
serves one over standard input/output for local clients that start their own
servers.

MCP tools, Pi tools and CLI commands are generated from one catalogue of
operations in the core, so the surfaces never drift apart. Each MCP tool is
`vault_<operation>`; it names the vault it acts on as `vault` (or in a
`<vault-id>:<path>`), or for an operation over many vaults as `vaults` —
by default every vault the profile permits it for.

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

## Sharing an endpoint

Profiles with the same `listen` address and port share one endpoint, and the
path chooses the profile: `/mcp/<profile>`. One of them may be the endpoint's
`default`, which serves `/mcp` and every name the endpoint does not have; a
profile alone on its endpoint is its default. Without a default, those paths
are not found. A socket or named-pipe path serves one profile.

```yaml
mcp:
  profiles:
    - name: assistant                 # anyone the client cannot name: read only
      listen: 127.0.0.1:8735
      token: ${VAULT_MCP_ASSISTANT}
      default: true
      vaults: { home-knowledge: [search, read] }
    - name: assistant-alice           # served at /mcp/assistant-alice
      listen: 127.0.0.1:8735
      token: ${VAULT_MCP_ASSISTANT}
      vaults: { home-knowledge: [search, read], memories-alice: [search, read, "@propose"] }
```

This is for a client that serves several people and can name the one it acts
for in the URL — a chat front-end putting the signed-in user's name in the path,
say — so each person's sessions see only their own vaults, and a name that
matches no profile (an account added later, an empty one) gets the default
rather than an error. Make the default the least privileged profile.

The path is a choice, not an identity: the token is what admits a request, so
profiles that share a token are separated only as far as their clients choose
honestly. That keeps a well-meaning client's sessions apart; a client that must
not reach another's profile gets a token of its own.

## Rules

- **A token for every HTTP profile.** Each profile served on an address and
  port requires a bearer token (from `${ENV}` or `!command`), and a request is
  checked against the token of the profile its path chooses; there is no
  anonymous access and no per-client identity within a profile. A socket or
  named-pipe endpoint is protected by being accessible only to the user instead.
  Standard-I/O servers trust the process that started them.
- **Loopback by default.** Endpoints do not terminate TLS; expose one beyond the
  machine only through a reverse proxy that does.
- **Accept needs an owner.** `accept` works only on a profile that declares an
  `owner`, and the approval attestation records both the owner and the profile.
  Reviews through a profile are its owner's too.
- **Writes name their actor.** `write` and `commit` require the actor to write
  as — one of the vault's `actors`, never an owner, not even the profile's —
  and are refused while another session holds it.
- **MCP commits are tainted.** Every commit made through MCP carries
  `Vault-Tainted`: the package cannot know what the client read, so it fails
  closed, as unknown tools do in a Pi session.
- **Only listed tools exist.** A client sees exactly the operations its profile
  permits for at least one vault, in a stable order; calls for a vault where
  the operation is not permitted are refused — the same way as for a vault
  that does not exist, so a profile cannot learn of vaults it may not touch.
- **No confirmation through MCP.** Adopting `main` shows its delta but is never
  confirmed over MCP: confirming is the person's, at the CLI or in Pi.
- **Same behaviour everywhere.** An operation over MCP enforces exactly what it
  enforces in Pi or the CLI — merge policy, write guards, scripts from the
  accepted `main` — and every response for a vault with an unaccepted change
  carries the same notice. One difference: where a notice or an error gives
  commands to run by hand, a client on another machine is told they are for
  the vault's own machine instead of getting its directories.
- **One daemon per installation.** Different permission sets are separate
  profiles, not separate daemons: the daemon also owns scheduling, which must
  not run twice. `vault mcp` processes only run operations, so any number can
  run alongside it.
