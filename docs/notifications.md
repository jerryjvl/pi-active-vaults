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
    auth:
      type: oauth2                # preferred; or `password` with a `password:` secret
      authorize-url: https://accounts.example.net/o/oauth2/auth
      token-url: https://oauth2.example.net/token
      scope: https://mail.example.net/
      client-id: ${SMTP_CLIENT_ID}
      client-secret: "!<command that prints the client secret>"
      refresh-token: "!<command that prints the refresh token>"
  limits: { per-hour: 10, max-bytes: 200000, cooldown: 12h }
```

With `oauth2`, the package exchanges the refresh token for short-lived access
tokens and authenticates with SMTP `XOAUTH2`. Every endpoint and the scope are
configuration, so any provider that supports OAuth for SMTP works.

`vault notify authorize` obtains the refresh token once: it opens the provider's
consent page in a browser, receives the result on a local loopback address,
and prints the refresh token for the user to store in their keyring. The daemon
refreshes the access token at least monthly so the refresh token does not
expire from disuse; a failure is reported by `vault status` and `vault doctor`
(it cannot be emailed).

| Transport | Use when |
|---|---|
| `smtp` | Default. Authenticated submission to any provider's mail server. |
| `sendmail` | The machine already has a configured mail command (for example `msmtp`); the package passes the message to it on standard input. |

## Guarantees

**Recipients cannot be redirected.** The script accepts only aliases. Addresses
exist only in the installation config, are validated when it loads (exactly one
`@`, ASCII, no separators), and are the only values used for the envelope and
headers. Text in a message body or a prompt cannot add or change a recipient.

**Secrets are never exposed.**

- Credentials (refresh token, client secret, or password) are `!command`s
  (typically a keyring lookup: `secret-tool` on Linux, `security` on macOS,
  PowerShell `Get-Secret` on Windows) or `${ENV}` references — never literals,
  and never in a vault.
- It is resolved inside the sending process: not in arguments, logs, traces or
  anything a model sees.
- SMTP connections are encrypted before authentication: port 465 uses TLS from
  the start; port 587 requires STARTTLS and fails if the server does not offer
  it. There is no plaintext fallback. Certificates are always verified; TLS 1.2
  is the minimum.
- A dedicated sending account is recommended — especially with OAuth, where
  providers often grant SMTP access only through a full-mailbox scope: on an
  account that holds nothing but sent notifications, that scope exposes little
  more than sending.

**Delivery is reliable without a dedicated provider.** Mail goes through an
authenticated account at the user's own provider, so it is signed and accepted
like any other mail from that account. Direct delivery to recipients' servers is
not supported: home connections are commonly blocked or treated as spam.

**Nothing is lost on failure.** Each message is recorded in the outbox in the
state database before sending and marked sent only after the server accepts it.
The daemon retries failures with backoff; undelivered messages appear in
`vault status` and `vault doctor`. The
`Message-ID` is derived from the trace ID and key, so a retry is recognisably
the same message.

**Volume is bounded.** Per-hour and size limits apply; bodies are plain UTF-8
text.

## Records

Every send is recorded in the run's trace: alias, subject, `Message-ID`,
outcome. Credentials and full addresses are not recorded.

## Implementation

SMTP uses `nodemailer` (MIT-0, no dependencies) with `secure` for port 465 or
`requireTLS` for 587, and its OAuth 2.0 support for `XOAUTH2`. Hand-written
SMTP and MIME handling is avoided.
