# Notifications

One built-in delivery mechanism, available to every vault: the vetted script
`builtin:notify`, which sends email. Email is the common denominator — every
person and device can receive it, and every provider can send it.

## Use

```
builtin:notify --to <alias> --subject <text> [--body-file <file>] [--key <id>] [--markdown | --plain]
```

The body is read from `--body-file` or standard input. Sessions run it through
the `vault_script` tool; people and scripts use `vault notify`.

| Option | Meaning |
|---|---|
| `--to` | A recipient **alias** from the installation config. Raw addresses are rejected. |
| `--subject` | Subject line. Line breaks are removed. |
| `--key` | Deduplication key. A second message with the same key inside its cooldown is dropped. |
| `--markdown` | Send the body as Markdown (the default for a `.md` or `.markdown` body file). |
| `--plain` | Send a Markdown body file as it is. |

A **Markdown body** is sent to be read, not decoded: its front matter is
dropped, and the message carries the Markdown as text with an HTML alternative
rendered from a small subset — headings, paragraphs, lists, quotes, code,
rules, bold, italics, inline code and links. Everything in the body is escaped
first, so HTML in it (perhaps from a web page) is shown, never rendered; only
`http` and `https` links become links; nothing is fetched or embedded. The
HTML is kept with the message, so a retry sends the same message.

It prints the outcome — `sent`, `queued` (kept for retry), `duplicate` or
`undeliverable` — and the `Message-ID`, and exits `0`; a refusal (a raw
address, an unknown alias, a limit) exits `3`, and a usage error `2`, as the
CLI's commands do.

## Configuration

In the installation config:

```yaml
notify:
  from: "Vault <vault@example.net>"
  recipients:
    me: me@example.net
  transport:
    type: smtp
    host: smtp.example.net
    port: 465                     # 465: TLS from the start; 587: STARTTLS, required
    user: vault@example.net
    password: "!<command that prints the password>"   # or ${SMTP_PASSWORD}
  limits: { per-hour: 10, max-bytes: 200000, cooldown: 12h }
  spools:                       # optional: a drop directory per alias (below)
    me: /var/spool/pi-active-vaults/me
```

| Transport | Use when |
|---|---|
| `smtp` | Default. Authenticated submission to any provider's mail server. |
| `sendmail` | The machine already has a configured mail command (for example `msmtp`); the package passes the message to it on standard input. Keys: `command`, and `args` (default `[-t, -i]`). |

`port` is `465` or `587`; there is no other. `limits` default to the values
shown; `max-bytes` bounds the body.

## Guarantees

**Recipients cannot be redirected.** The script accepts only aliases. Addresses
exist only in the installation config, are validated when it loads (exactly one
`@`, ASCII, no separators), and are the only values used for the envelope and
headers. Text in a message body or a prompt cannot add or change a recipient.

**Secrets are never exposed.**

- The password is a `!command` (typically a keyring lookup: `secret-tool` on
  Linux, `security` on macOS, PowerShell `Get-Secret` on Windows) or an `${ENV}`
  reference — never a literal, and never in a vault.
- It is resolved inside the sending process: not in arguments, logs, traces or
  anything a model sees.
- SMTP connections are encrypted before authentication: port 465 uses TLS from
  the start; port 587 requires STARTTLS and fails if the server does not offer
  it. There is no plaintext fallback. Certificates are always verified; TLS 1.2
  is the minimum.
- A dedicated sending account with an app-specific password is recommended.

**Delivery is reliable without a dedicated provider.** Mail goes through an
authenticated account at the user's own provider, so it is signed and accepted
like any other mail from that account. Direct delivery to recipients' servers is
not supported: home connections are commonly blocked or treated as spam.

**Nothing is lost on failure.** Each message is recorded in the outbox in the
state database before sending and marked sent only after the server accepts it.
The daemon retries failures with backoff, from a minute up to six hours, and
never gives up; a message whose alias has since been removed from the config
is undeliverable. Undelivered messages appear in `vault status` and `vault
doctor`. The `Message-ID` is derived from the trace ID, the key and how many
messages that trace sent with that key before, so a retry is recognisably the
same message and a later one is not. `vault notify test --to <alias>` delivers
one test message at once, outside the outbox, and reports why it failed.

**Volume is bounded.** Per-hour and size limits apply; bodies are plain UTF-8
text.

## Spools

A spool lets a process that must not read the installation's config or
secrets — a sandboxed service, a system unit running as another user — ask for
a notification. `notify.spools` maps a recipient alias to a directory; the
daemon reads each directory every minute and sends what it finds there to
that alias, and to no other.

A message is a small UTF-8 file: header lines, a blank line, then the body.

```
Subject: Blocked fetch
Key: web-mcp:card
Format: plain

A URL carrying a card number was refused.
```

| Header | Meaning |
|---|---|
| `Subject` | Required. Line breaks are removed, as for any notification. |
| `Key` | Optional deduplication key (letters, digits, `.`, `_`, `:`, `-`): a second message with it inside the cooldown is dropped. |
| `Format` | `plain` (default) or `markdown`, which sends the body readable with an HTML alternative. |

There is no recipient header: the directory is the recipient. Write the file
under a name starting with `.` and rename it into place; names starting with
`.` are never read, so a message is never read half-written. The file must be
readable by the daemon's user — give it group read.

What the daemon does with each message, oldest first:

- **Valid:** it goes through the outbox like any other notification (the same
  limits, deduplication and retries) and the file is removed.
- **Invalid** — no subject, an unknown header, not UTF-8, larger than the size
  limit, not a regular file, not readable: renamed `.rejected-<name>`, never
  retried. `vault doctor` reports them; read them for what was wrong, then
  delete them.
- **Over the limit:** a spool may send at most half the hour's notifications
  (`per-hour`, at least one), so a busy spool cannot crowd out the vaults' own
  messages. Messages over that wait for a later pass; `vault doctor` reports
  any that wait more than an hour.

**Permissions are the access control.** Create each directory owned by the
daemon's user, with a group of the processes allowed to notify that alias,
mode `2730`: the group may create files but not list or read the directory, so
writers cannot see each other's messages, and the setgid bit gives every file
the directory's group. Put the daemon's user in that group so it can read
what writers leave. One group per spool lets each alias be granted on its own.
`vault doctor` checks the owner, that others have no access, that the group
can write but not list, and that the daemon's user is in the group. The
package never creates or changes a spool directory: the system's own
configuration does.

## Records

Every send is recorded in the run's trace: alias, subject, `Message-ID`,
outcome. Credentials and full addresses are not recorded.

## Implementation

SMTP uses `nodemailer` (MIT-0, no dependencies) with `secure` for port 465 or
`requireTLS` for 587. Hand-written SMTP and MIME handling is avoided.
