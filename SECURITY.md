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
it — trusted networks only, or a VPN / HTTPS proxy in front (see
[HTTPS on a LAN](#https-on-a-lan)).

| Surface | Protection |
|---|---|
| HTTP + WebSocket (`:8787`) | Loopback bind by default; origin check always (a foreign web page is refused). In LAN mode: token required for every non-loopback request, roles `owner` / `manager` / `viewer`. |
| `POST /approval-response` | Loopback or a `manager`/`owner` token. Whoever can call it can approve any pending agent action. |
| `POST /open`, `POST /sessions/open-terminal`, `GET /outputs` | `/open` and `/sessions/open-terminal` act on the host desktop and are owner-only. `/sessions/open-terminal` only opens directories the daemon itself saw a session work in. `/open` and `GET /outputs` use whitelisted roots resolved with `realpath` so symlinks cannot escape. |
| `POST /zalo/webhook` | Reachable without a token **only while the Zalo channel is configured** (`ZALO_OA_TOKEN` + `ZALO_APP_ID` + `ZALO_OA_SECRET`; Zalo's servers cannot send a token); body capped at 64 KB. Each event is checked against Zalo's `X-ZEvent-Signature` before it is read, and only paired project members (plus the optional owner chat `ZALO_ALLOWED_USER`) are heard. |
| Telegram channel | Long polling only (no inbound port). Hears `TELEGRAM_CHAT_ID` and paired project members; every approve/deny is checked against the member's role. |

### Requests that carry no `Origin`

The origin check refuses a request whose `Origin` header names a foreign site. A request
with **no** `Origin` header is allowed, because curl, an address-bar visit and the served
app's own simple GETs send none. The same is true of an `<img>` tag or a link click on a
foreign page, so a web page you open can make your browser send such a request to the
daemon. A page cannot read the response, but the request still arrives.

Every route that changes state is a POST, which a browser sends with an `Origin` (or
preflights). The one GET route that had a side effect was `/harnesses?probe=<key>`, which
runs the harness CLI: for Claude it runs `claude auth status` (no tokens), for Gemini it
sends a real prompt. It now also refuses a request the browser marks `Sec-Fetch-Site:
cross-site` or `same-site`. The served app, curl and the address bar are unaffected.
This relies on the browser sending Fetch Metadata headers (all current browsers do); a browser without them (Safari before 16.4 is one) looks like curl and is not stopped. A link opened from another app, typed in, or from a bookmark arrives with `Sec-Fetch-Site: none` and can still trigger a Gemini probe; that is accepted, as it needs the user to open the link. Over plain HTTP on a LAN the protection is the token plus the `SameSite=Strict` session cookie, not Fetch Metadata. Other GET routes only read (the one exception is `GET /docs*` renaming a corrupt `docs-meta.json` aside, which an outside page cannot cause: it needs the file to be corrupt already and changes nothing else).

Known limits: DNS rebinding against the loopback interface is closed — a loopback request only
counts as the local user when its `Host` is a loopback name (`localhost`, `127.0.0.1`,
`::1`, `0.0.0.0`); any other name needs a token. Opening the office by the machine's own hostname
therefore asks for an access link. And anyone with a shell on
the machine is the owner.

## HTTPS on a LAN

LAN mode serves plain HTTP; the daemon has no TLS of its own. To keep the access token
off the wire, put a TLS terminator in front and keep the daemon itself on loopback.

- **VPN (for example Tailscale):** traffic between devices is already encrypted, so
  plain HTTP over the VPN address is acceptable. Not tested here.
- **`tailscale serve` or a reverse proxy with a self-signed certificate** (Caddy, nginx)
  that forwards to `127.0.0.1:8787`: not tested here, so no commands are given. Check
  that the proxy forwards the WebSocket upgrade and keeps the `Host` header. Note that a
  proxy on the same machine makes every request arrive from loopback, and the token check is bypassed only if the proxy rewrites `Host` to a loopback name; the daemon treats
  requests carrying proxy headers (`X-Forwarded-For` and friends) as remote, so the proxy
  must send them or the token check is bypassed. Verify with a request from another device.

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
