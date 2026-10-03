# Website enquiry relay

I use my existing Google Workspace mailbox to receive website enquiries. This
small relay has one purpose: accept an authenticated request from the website
and submit a plain-text message to `valerii@vkvstudio.com` through Google's SMTP
relay. It does not run editorial workflows, outreach, Synapse or n8n.

The implementation uses Python's standard library, with no additional Python
packages. It is intended for Python3.10 or later on a Linux host with systemd.
These files are deployment source; their presence does not mean that a live
relay, Workspace rule or website binding has been configured.

## Boundaries

The browser submits to the website's same-origin `/api/contact` handler. That
handler retains independent input validation, the exact allowed Origin,
Turnstile verification and the configured edge rate limit. It constructs the
mail text and signs one request to
`https://api.vkvstudio.com/_internal/vkv-contact`.

The relay verifies the signature over the exact method, path, timestamp, nonce
and body hash, then validates the body again. Sender and recipient are fixed
to `valerii@vkvstudio.com`. Only the validated visitor address can become
`Reply-To`. User input cannot select a recipient, SMTP host, attachment, HTML
body or arbitrary header.

SMTP connects only to `smtp-relay.gmail.com:587`, verifies the TLS certificate
and requires STARTTLS. The Workspace administrator must allow the host's exact
egress IP and require TLS. The SMTP rule authorizes registered Workspace
senders from that host; the application's narrower recipient restriction is
separate. No mailbox password is used by this mode.

A successful result means Google accepted the SMTP submission for queuing. It
does not prove arrival in the inbox. An uncertain SMTP outcome is not retried
automatically. A fresh, explicitly submitted request may retry the same enquiry
only after a confirmed failure before mail submission. Each attempt counts
separately toward the sending limits, including failed attempts.

The private SQLite ledger retains request identifiers, hashes
and outcomes, without storing enquiry text or addresses, to prevent duplicate
dispatch after a restart.

## Runtime isolation

`vkvstudio-contact-relay.socket` creates only a Unix-domain socket:
`/run/vkvstudio-contact-relay.sock`. It has mode0660 and group `cloudflared` so
the existing connector can reach it. There is no new TCP listener.

The service receives that listening socket through systemd's file descriptor3.
It runs as a separate dynamic user and does **not** join the connector's group.
This avoids granting it access to the connector's group-readable files. Its
private state directory is `/var/lib/vkvstudio-contact-relay`, managed by
systemd with mode0700. Resource limits and service isolation are in the unit.
They must be checked on the destination host before activation.

An operator provides a new 32-byte random HMAC key as lowercase hexadecimal in
two secret stores: the Pages runtime secret `CONTACT_RELAY_HMAC_KEY` and the
root-owned credential source `/etc/vkvstudio-contact-relay/relay-hmac`.
Systemd passes the latter through `LoadCredential`. Keep the enclosing directory
private and the source file mode0600. Never put the value in this repository,
build inputs, process arguments, logs, browser configuration or test fixtures.
The units and code contain no real key.

The key identifier `workspace-v1` is public metadata. Coordinated key rotation
must preserve the idempotency ledger. Do not reset ambiguous entries to retry
messages whose SMTP outcome is unknown.

## Activation checklist

1. Review and test the exact source revision with synthetic data. Verify the
   service/socket units on the destination host. Preserve existing services,
   connector routes, state and credentials.
2. Have the Workspace administrator approve the exact IP/TLS SMTP rule.
3. Install the reviewed script and these two units. Provision the new key
   through protected operator-controlled channels, without displaying it.
4. Obtain approval for a narrowly matched connector route covering only
   `^/_internal/vkv-contact(?:/readiness)?$` on `api.vkvstudio.com`, targeting
   `unix:/run/vkvstudio-contact-relay.sock`. Preserve the existing routes and
   fallback. This sample is not permission to change a live shared tunnel.
5. Configure Pages runtime bindings, Turnstile and the actual edge rate rule.
   Do not mark a deployment ready merely because a readiness variable is set.
6. Start the socket/service, verify authenticated readiness and rejection of
   unsigned requests, then send only an authorized, clearly marked canary to
   the fixed mailbox. Confirm actual mailbox receipt separately from SMTP
   acceptance before calling delivery ready.

Runtime bindings for this mode:

| Binding | Value or purpose |
| --- | --- |
| `CONTACT_DELIVERY_TRANSPORT` | `workspace-relay` |
| `CONTACT_RELAY_URL` | The exact fixed HTTPS endpoint above |
| `CONTACT_RELAY_KEY_ID` | `workspace-v1` |
| `CONTACT_RELAY_HMAC_KEY` | New shared secret, runtime only |
| `CONTACT_RELAY_READY` | `true` only after activation checks |
| `CONTACT_TURNSTILE_SITE_KEY` | Public widget identifier for the website |
| `CONTACT_TURNSTILE_SECRET` | Runtime-only verification secret |
| `CONTACT_EDGE_RATE_LIMIT_READY` | `true` only after the actual edge rule is verified |

A supported `CONTACT_RATE_LIMIT` binding may replace the last flag only when
the deployment platform actually supports and configures it. Do not assume
that every Workers binding is available on Pages.

## Testing and limits

Run `test_relay.py` with an explicit Python interpreter. The tests must use
synthetic credentials, temporary synthetic databases and fake SMTP. They must
not load production environment files, contact Google or send mail.

Security checks have a scope. Local tests establish the behavior they exercise;
they do not establish DNS routing, the Workspace account's configuration,
production delivery, protection against every attack or permanent uptime.
Operator activation and live canary checks are separate evidence.
