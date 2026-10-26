# Security

## What this software actually does

Agent Office reads the transcripts your coding agents write on this machine, and
it can **answer permission prompts on their behalf**. Approving a prompt is how
an agent gets to run a command, write a file, or reach the network. Treat the
daemon's port as equivalent to a shell on your machine.

## Threat model

By default the daemon binds `127.0.0.1` and a request from this machine needs no
authentication. That is a deliberate trade for a single-user desktop tool, and it is
only safe because of where it listens: the security boundary is the loopback
interface.

**LAN mode is opt-in** (`node scripts/ao.mjs lan on`, see [docs/onprem.md](docs/onprem.md)).
It listens on the network and then requires a token on **every non-loopback request,
HTTP and WebSocket**; a viewer token is read-only. Tokens are 256 random bits, stored
only as SHA-256 hashes in `~/.agent-office/access.json` (mode 600). Requests carrying
proxy headers (`X-Forwarded-For` etc.) are treated as remote even from 127.0.0.1.
The transport is plain HTTP, so on a LAN the token is visible to anyone who can sniff
it — trusted networks only, or a VPN / HTTPS proxy in front.

| Surface | Protection |
|---|---|
| HTTP + WebSocket (`:8787`) | Loopback bind by default; origin check always (a foreign web page is refused). In LAN mode: token required for every non-loopback request, roles `owner` / `manager` / `viewer`. |
| `POST /approval-response` | Loopback or a `manager`/`owner` token. Whoever can call it can approve any pending agent action. |
| `POST /open`, `GET /outputs` | `/open` is owner-only; both use whitelisted roots resolved with `realpath` so symlinks cannot escape. |
| `POST /zalo/webhook` | Reachable without a token because Zalo's servers cannot send one; ignores every sender that is not `ZALO_ALLOWED_USER` and is disabled unless the Zalo env vars are set. |
| Telegram bridge | Ignores every update whose chat id is not `TELEGRAM_CHAT_ID`. |

Known limits: a malicious web page can still try DNS rebinding against the loopback
interface (the origin check trusts a same-host `Origin`); and anyone with a shell on
the machine is the owner.

## Do not do this

- **Do not set `DAEMON_WS_HOST` to `0.0.0.0`** or any routable address by hand
  without creating tokens first. Use `lan on`, which does both. A bind with no tokens
  refuses every remote request rather than serving them, but you get nothing
  from it either.
- **Do not run this on a shared or multi-user machine.** Any local user can
  reach loopback and approve agent actions as you.
- **Do not expose the port through a tunnel, reverse proxy, or port forward**
  without putting real authentication in front of it. `ssh -L` to your own
  machine is fine; a public hostname is not. A VPN (Tailscale etc.) is fine.

## Reporting a vulnerability

Open a GitHub issue for anything that is not itself exploitable from the report.
For something sensitive, use GitHub's private vulnerability reporting on this
repository instead of a public issue.

This is a personal project maintained in spare time. There is no SLA — expect a
best-effort reply, not a guaranteed response window.
