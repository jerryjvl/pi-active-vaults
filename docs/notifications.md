# Notifications

One built-in delivery mechanism, available to every vault: the vetted script
`builtin:notify`, which sends email. Email is the common denominator — every
person and device can receive it, and every provider can send it.

## Use

```
builtin:notify --to <alias> --subject <text> [--body-file <file>] [--key <id>]
```

The body is read from `--body-file` or standard input. Sessions run it through
the `vault_script` tool; people and scripts use `vault notify`.

| Option | Meaning |
|---|---|
| `--to` | A recipient **alias** from the installation config. Raw addresses are rejected. |
| `--subject` | Subject line. Line breaks are removed. |
| `--key` | Deduplication key. A second message with the same key inside its cooldown is dropped. |

It prints the outcome — `sent`, `queued` (kept for retry), `duplicate` or
`undeliverable` — and the `Message-ID`, and exits `0`; a refusal (a raw
address, an unknown alias, a limit) exits `1`, and a usage error `2`.

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
same message and a later one is not.

**Volume is bounded.** Per-hour and size limits apply; bodies are plain UTF-8
text.

## Records

Every send is recorded in the run's trace: alias, subject, `Message-ID`,
outcome. Credentials and full addresses are not recorded.

## Implementation

SMTP uses `nodemailer` (MIT-0, no dependencies) with `secure` for port 465 or
`requireTLS` for 587. Hand-written SMTP and MIME handling is avoided.
