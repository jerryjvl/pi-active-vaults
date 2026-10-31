# Signer

Holds a signing key, and makes signed statements for processes that must not
hold it. It runs as an operating-system user of its own, so neither the daemon
nor the sessions it starts can read the key: a process of the daemon's user can
ask for a statement, but never make one.

Each kind of statement the signer makes is defined by the core module that owns
its purpose. [Web grants](../concepts.md#web-grants) are the first.

## What it signs

A kind derives what it states from sources the signer reads itself, never from
the request. A request says only what to state about: for a web grant, a vault,
a job and a run's trace. So whoever can reach the socket gets only statements
about what an owner already reviewed.

The signer's view of a vault is its own fetch of `main`, from the address in its
own configuration:

| Address | Trusted because |
|---|---|
| The forge (`https`, `ssh` or `user@host:path`) | The forge protects `main`: nothing reaches it without an owner's approval |
| A local path, only with `local: true` | The owner chose to; a same-user process can change that `main` (security.md "What is not guaranteed") |

## Statements

A statement is a compact JWS (RFC 7515) signed with Ed25519 (`EdDSA`, RFC 8037):

- Its header is exactly `alg`, `kid` (the first 16 characters of the base64url
  SHA-256 of the raw public key) and `typ`, the statement's type.
- Its payload is canonical JSON. It is at most 8 KB, so it fits in an HTTP header or an
  environment variable.
- A verifier accepts only the one type it asks for, signed by a key it trusts,
  intact and before its `exp`.

A statement is a capability, not a secret: it allows only what it says, until it
expires. Only the private key is secret.

| Kind (`params.kind`) | Type | Defined in |
|---|---|---|
| `web-grant` | `vault-grant` | `grants` (concepts.md "Web grants") |

A new kind needs a type of its own, its derivation from the signer's own sources,
and an entry in the core's list of kinds (`operations`).

## Configuration

The `signer` section of the installation config of the user it runs as:

```yaml
signer:
  key: "!cat /etc/vault-signer/key.pem"   # the private key, PEM, as a secret reference
  socket: /srv/vault-signer/signer.sock   # optional; default <state>/signer.sock (a named pipe on Windows)
  socket-access: group                    # optional: user (default) or group, for a daemon of another user in its group
  vaults:
    - { id: digests, url: "ssh://git@git.example.net/home/vault-digests.git" }
    - { id: notes, url: ~/vaults/notes, local: true }
  web-grant: { wildcard-min: 20 }         # optional; see concepts.md "Web grants"
```

`socket-access: group` is refused on Windows, where a named pipe's access cannot
be set to let another user in.

## Protocol

JSON lines over its socket, as the [daemon's](daemon.md#socket-protocol). A
request is `{ id, method, params }`, answered `{ id, ok: true, result }` or
`{ id, ok: false, error: { reason, text } }`.

| Method | Params | Result |
|---|---|---|
| `ping` | — | `version`, `kid`, and `kinds`: each kind's name with what a client may need of it (`web-grant`: `wildcardMin`) |
| `sign` | `kind`, and that kind's request | The kind's statement(s) |

Each statement made or refused is one line in the service's log: its kind and
what it was about, never the statement or the key.

## Setting it up

The signer runs only as a service of a user of its own, and only an
administrator can create one:

1. Create the user, with a group the daemon's user is in when the daemon will
   ask over a `group` socket.
2. As that user, run `vault signer key <file>`. It writes the private key to a
   new file only that user can read, and prints the public key as a JWK for each
   verifier, such as each web broker.
3. Write that user's `signer` section, and run `vault signer run` as a service
   of that user: a systemd system unit with `User=` on Linux, or a launchd daemon
   with `UserName` on macOS.
4. Give the fetch credential to that user alone. Over SSH this is a read-only
   deploy key. For a local path, it is read access to the clone, and Git's
   `safe.directory` for it.

`vault doctor` checks the key where the signer runs, and that the signer
answers where the daemon asks it.

## Open questions

- Windows: running the signer as another user, and letting the daemon reach its
  named pipe.
