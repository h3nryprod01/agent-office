# Run Agent Office on your own machines

Agent Office runs entirely on a machine you control. There is no cloud service to
sign up for: a small background process (the *daemon*) watches the transcripts your
coding agents write on that machine and serves the office to a web browser. This
page is the whole path for someone starting from nothing: what to prepare, how to
install, how to let other people on your network in safely, how to back up, how to
update, and how to remove it.

Vietnamese version: [onprem.vi.md](onprem.vi.md).

## 1. What to prepare

| | Requirement |
|---|---|
| **Operating system** | macOS 13+, Ubuntu 22.04+ (or Debian-family Linux with systemd), or Windows 11. Windows 10 should work but is untested. |
| **Memory / disk** | 8 GB RAM recommended (4 GB is the practical minimum with one or two agents running). About 1 GB of disk for the install and build. |
| **Node.js** | 20 or newer (22 LTS recommended). |
| **git** | Needed to install and to run `update`. |
| **An agent CLI, signed in** | At least **Claude Code**, with an account that can use it (a Claude Pro/Max/Team plan, or an Anthropic API key). Codex CLI and Gemini CLI are optional extras. |
| **A browser** | Any current Chrome, Edge, Firefox or Safari. |
| **Network** | Outbound HTTPS to the agent vendors (the CLIs need it, not Agent Office). Nothing inbound is needed unless you open the office to your LAN (section 4), and then only one TCP port, `8787` by default. |

Agent Office itself sends nothing to anyone. The only things that leave the machine
are what the agent CLIs send to their own vendors, and the optional Telegram/Zalo
bridges if you configure them.

Not sure you have everything? Install first, then run the checker (section 2): it
tells you what is missing and the exact command that fixes it.

## 2. Install

Get the code (any folder you own works):

```bash
git clone https://github.com/h3nryprod01/agent-office
cd agent-office
```

Then run the start script for your system. Each one installs the dependencies,
builds the app, installs the daemon as a background service that starts when you log
in and restarts itself if it crashes, and opens the office.

| System | Command |
|---|---|
| macOS | `./scripts/start.sh` |
| Ubuntu / Debian | `./scripts/install-ubuntu.sh` |
| Windows (PowerShell, from the repo folder) | `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` |

Before it installs anything the script checks the basics (Node version, `npm`, the
port, whether your data folder is writable) and stops with the fix if one of them
would break the start.

The office is now at **http://localhost:8787**. Use `localhost`, not `127.0.0.1`:
the browser treats them as different sites and asks for microphone permission
separately.

### The readiness checker

At any time, on any of the three systems:

```bash
./scripts/start.sh doctor                                      # macOS
./scripts/install-ubuntu.sh doctor                             # Linux
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 doctor   # Windows
```

(or `node scripts/ao.mjs doctor` anywhere). It prints one line per check and, under
every problem, the command that fixes it:

```text
[ok]   Node.js 22.1.0
[FAIL] Claude Code not found on PATH — the PM chat and approvals need it
        fix: npm install -g @anthropic-ai/claude-code   then run `claude` once and sign in
[FAIL] port 8787 is used by another program
        fix: find it with: lsof -i :8787   — stop it, or run Agent Office on another port: DAEMON_WS_PORT=8788
```

It checks: Node 20+, `npm`, `git`, `claude` / `codex` / `gemini` on the PATH, that the
port is free (or already ours), that the data folder is writable, that dependencies
and the build are present, memory, whether LAN access is on and has tokens, and
whether the background service is installed. It only reads; it never changes
anything. Add `--json` for machine-readable output.

### The commands you will use

All of these are `node scripts/ao.mjs <verb>`, and also work as
`./scripts/start.sh <verb>` (macOS), `./scripts/install-ubuntu.sh <verb>` (Linux)
and `scripts\start.ps1 <verb>` (Windows).

| Verb | What it does |
|---|---|
| `doctor` | Is this machine ready? What to type to fix what is not. |
| `update` | Back up your data, `git pull`, reinstall dependencies, rebuild, restart the service. `--dry-run` shows the steps without running them. |
| `backup [--out DIR]` | Archive your data (section 5). |
| `restore <archive>` | Put an archive back (section 5). |
| `lan on` / `lan off` / `lan status` | Let other machines in / go back to this machine only (section 4). |
| `token add --label <name> --role <role>` | Create an access link for a person. |
| `token list` / `token revoke <id-or-label>` | See who has access / cut someone off. |

### Updating

```bash
node scripts/ao.mjs update
```

It refuses to run if you have edited files in the checkout (it will not pull over
your changes) and tells you how to set them aside. It backs up your data first, and
builds the new app beside the old one, swapping it in only if the build succeeded.
If installing or building fails after the pull, it puts the previous version back
(`git reset --hard` to where it started, dependencies reinstalled) and does **not**
restart the service onto a broken build; if even that fails, the error lists the
exact commands to run by hand.

### Logs and service names

| | macOS | Linux | Windows |
|---|---|---|---|
| Service | launchd `com.agentoffice.daemon` | systemd user unit `agent-office-daemon` | Scheduled Task `AgentOfficeDaemon` |
| Log | `~/Library/Logs/agent-office-daemon.log` | `journalctl --user -u agent-office-daemon` | `%LOCALAPPDATA%\agent-office\agent-office-daemon.log` |

Your data lives in `~/.agent-office` (`%USERPROFILE%\.agent-office` on Windows):
projects, work items, and the access list. Set `AGENT_OFFICE_HOME` to keep it
somewhere else.

## 3. Who can see what: roles

| Role | Can do |
|---|---|
| **owner** | Everything, including actions that act on the host machine's desktop (such as opening a file in Finder/Explorer). |
| **manager** | Read everything and make changes: chat with the PM agent, answer agent approval prompts, create projects and work items, apply company templates. |
| **viewer** | Read only. Sees the office, board, activity and spend. Cannot chat, approve, create or change anything, and cannot trigger the agent-login probe. |

Anyone using the office **from the machine it runs on** is the owner, with no token,
exactly as before. The roles only matter for people connecting over the network.

A viewer sees what the agents are doing (tool calls, file names, commands, costs).
Give viewer links only to people who are allowed to see that.

## 4. Let other people in (LAN mode)

By default the daemon listens on this machine only. To let colleagues on the same
network open the office:

```bash
node scripts/ao.mjs lan on
```

This switches the daemon to listen on the network, creates the first **owner** link
if none exists, restarts the service, and prints a link such as:

```text
Access link (owner) — shown once, copy it now:
  http://192.0.2.10:8787/?ao_token=ao_...
```

The link contains a secret token. **It is shown once**: only a hash is stored, so if
you lose it, make a new one.

Opening that link in a browser signs that browser in: the address bar is cleaned
up straight away, and a cookie (HttpOnly, SameSite=Strict, 30 days) keeps the session.
The same token can also be sent by tools as `Authorization: Bearer <token>`.

### Give someone access

```bash
node scripts/ao.mjs token add --label "Mai" --role viewer
node scripts/ao.mjs token add --label "An"  --role manager
```

Send each person their own link. One token per person means you can cut one person
off without affecting the others:

```bash
node scripts/ao.mjs token list
node scripts/ao.mjs token revoke Mai        # no restart needed; live connections are closed within a few seconds
```

### Switch it off again

```bash
node scripts/ao.mjs lan off
```

The daemon goes back to this machine only. Tokens are kept, so `lan on` later
brings the same people back.

### What the daemon enforces

* A request from this machine (loopback) needs nothing, as before.
* **Every other request, HTTP and WebSocket, needs a valid token**, otherwise it gets
  `401`. A browser without one sees a page asking for the access link.
* A viewer's write requests get `403`.
* The cross-origin check from before still runs first: a web page on another site
  cannot use your token.
* Requests that arrive with proxy headers (`X-Forwarded-For` and friends) are treated
  as remote even if they come from this machine, so a tunnel or reverse proxy on the
  same host does not silently make the whole internet "local".
* Tokens are 256 random bits, stored only as SHA-256 hashes in
  `~/.agent-office/access.json` (file mode 600).

### Be honest about the network

This is plain HTTP. On the LAN a token travels in clear text, so anyone who can sniff
that network can copy it. That is acceptable on a home or office network you trust
and **not** acceptable on public Wi-Fi or anything routed over the internet. For
anything beyond a trusted LAN, put it behind a VPN such as Tailscale, or an HTTPS
reverse proxy that you configure to send `X-Forwarded-For` (so requests are treated
as remote and need tokens) and to keep the original `Host` header (nginx:
`proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr;`).
Without the first, every proxied request looks local and is treated as the owner;
without the second, the cross-origin check refuses the app's own requests. Do not
forward the port from your router to the internet.

Treat the daemon like a shell on that machine: an owner or manager can answer
permission prompts for agents running there. Do not use LAN mode on a shared,
multi-user computer.

### Firewall

* **macOS**: the first time, a dialog asks whether `node` may accept incoming
  connections. Choose Allow.
* **Windows**: allow `node.exe` on **Private** networks when the prompt appears, or
  once, from an administrator PowerShell:
  `New-NetFirewallRule -DisplayName "Agent Office" -Direction Inbound -Program "<full path to node.exe>" -Protocol TCP -LocalPort 8787 -Profile Private -Action Allow`
* **Linux (ufw)**: `sudo ufw allow from <your-lan-subnet> to any port 8787 proto tcp`

To find the address others should use, `lan on` prints a link for every network
address of the machine; pick the one on your shared network.

## 5. Back up and restore

```bash
node scripts/ao.mjs backup                       # to ~/agent-office-backups/
node scripts/ao.mjs backup --out /path/to/folder
```

This writes `agent-office-backup-<date>-<time>.tar.gz` containing your whole data
folder (`~/.agent-office`: projects and their work items, `access.json` with its token
hashes). The company roster in `~/.claude/company` lives outside it and is not included. It is created
readable by you only; keep it private. `update` makes one automatically before it
changes anything.

Restoring:

```bash
node scripts/ao.mjs restore ~/agent-office-backups/agent-office-backup-<date>-<time>.tar.gz
```

Restore checks the archive first and refuses anything unsafe (paths that climb out of
the folder, links, more than one top-level folder). It **never deletes** your current
data: that is moved to `…/.agent-office.pre-restore-<date>-<time>` next to it, so you
can always go back. The service is then restarted so it loads the restored data
(`--no-restart` skips that; on Windows, stop the `AgentOfficeDaemon` task first if the
restore fails on a locked file). The restored `access.json` comes back too, so the
command prints who has access; check it if the archive came from someone else.

## 6. Uninstall

First back up anything you want to keep (section 5).

**macOS**

```bash
./scripts/install-daemon-service.sh uninstall
rm -rf ~/Applications/Agent\ Office.app        # only if you created the app
```

**Linux**

```bash
systemctl --user disable --now agent-office-daemon
rm ~/.config/systemd/user/agent-office-daemon.service
rm -f ~/.local/share/applications/agent-office.desktop
rm -rf ~/.config/agent-office                  # holds the optional env file (Telegram token etc.)
systemctl --user daemon-reload
```

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1 uninstall
```

Then delete the repository folder. Your data, logs and backups are separate and are
only removed if you delete them yourself:

* data: `~/.agent-office` (Windows: `%USERPROFILE%\.agent-office`)
* backups: `~/agent-office-backups`
* log: see the table in section 2

## 7. When something goes wrong

Run `doctor` first. It covers most of this table.

| Symptom | Likely cause and fix |
|---|---|
| Blank page or 404 at `localhost:8787` | The app was never built. Run the start script. |
| "Disconnected" in the office | The daemon is down. Check the log (section 2), then run the start script. |
| A colleague sees "Access link required" | They need the link from `token add`. Tokens are shown once; make a new one if lost. |
| A colleague gets "Access link required" again after a while | Their cookie was cleared, or the token was revoked (`token list`). |
| A colleague cannot reach the address at all | LAN mode is off (`lan status`), a firewall blocks the port (section 4), or they are on a different network. |
| `update` says "local changes" | You edited files in the checkout. `git stash` them, then run `update`. |
| Port 8787 already in use | `doctor` shows what holds it. Stop that program, or run on another port with `DAEMON_WS_PORT`. |
| `claude` is installed but the office says it isn't | The service has a smaller PATH than your terminal. Re-install the service from a terminal where `claude` works: macOS `./scripts/install-daemon-service.sh`, Linux `./scripts/install-daemon-service-linux.sh`, Windows `scripts\install-daemon-service.ps1`. |

## What has and has not been tested

* **macOS and Linux**: the commands in this page were run, including `doctor`,
  `backup`/`restore`, `update` against a throwaway clone, and the LAN token flow
  with real requests from a non-loopback address.
* **Windows**: the daemon and its Scheduled Task were verified on a Windows 11 VM
  (see [windows-port.md](windows-port.md)). One thing to check on a real machine:
  the task runs `cmd.exe /c node …`, so `lan on|off` / `update` stop the task and then
  explicitly stop any leftover `node.exe` running the daemon script before starting it
  again; confirm with `Get-Process node` that exactly one daemon is running afterwards. `start.ps1` and the new verbs parse with
  zero errors and were dry-run under PowerShell 7 on macOS. **Not yet run on a real
  Windows machine**: `start.ps1` registering and starting the task end to end, the
  `update` restart through the Scheduled Task, `backup`/`restore` with Windows'
  bundled `tar.exe`, the firewall prompt in LAN mode, and a real Claude Code
  sign-in. On Windows, treat your first run as the test and tell us what breaks.
