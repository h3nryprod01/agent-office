# Security

## What this software actually does

Agent Office reads the transcripts your coding agents write on this machine, and
it can **answer permission prompts on their behalf**. Approving a prompt is how
an agent gets to run a command, write a file, or reach the network. Treat the
daemon's port as equivalent to a shell on your machine.

## Threat model

The daemon binds `127.0.0.1` and has **no authentication of any kind**. That is a
deliberate trade for a single-user desktop tool, and it is only safe because of
where it listens. The security boundary is the loopback interface — nothing else.

| Surface | Protection |
|---|---|
| HTTP + WebSocket (`:8787`) | Loopback bind only. **No auth, no CSRF token, no origin check.** |
| `POST /approval-response` | None beyond the bind. Anyone who can reach the port can approve any pending agent action. |
| `POST /open`, `GET /outputs` | Whitelisted roots, resolved with `realpath` so symlinks cannot escape. |
| Telegram bridge | Ignores every update whose chat id is not `TELEGRAM_CHAT_ID`. |
| Zalo bridge | Ignores every sender that is not `ZALO_ALLOWED_USER`. Disabled unless both env vars are set. |

## Do not do this

- **Do not set `DAEMON_WS_HOST` to `0.0.0.0`** or any routable address. It turns
  an unauthenticated approval gateway into a remote one — that is remote code
  execution against your own machine, by design, for anyone on the network.
- **Do not run this on a shared or multi-user machine.** Any local user can
  reach loopback and approve agent actions as you.
- **Do not expose the port through a tunnel, reverse proxy, or port forward**
  without putting real authentication in front of it. `ssh -L` to your own
  machine is fine; a public hostname is not.

## Reporting a vulnerability

Open a GitHub issue for anything that is not itself exploitable from the report.
For something sensitive, use GitHub's private vulnerability reporting on this
repository instead of a public issue.

This is a personal project maintained in spare time. There is no SLA — expect a
best-effort reply, not a guaranteed response window.
