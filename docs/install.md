# Install and run

Everything you need to run Agent Office on your own machine. Requires **Node 20+**
and nothing else.

## Running it

**macOS** — one command, from a fresh clone or on the morning of a demo:

```bash
./scripts/start.sh
```

It installs dependencies if they are missing, rebuilds the renderer and opens
**http://localhost:8787**. If no daemon is running it **asks** whether to install
one as a login service (launchd on macOS, systemd `--user` on Linux). Answer no
and the daemon runs in that terminal until Ctrl+C; `--yes` answers yes without
asking. Nothing is installed without a yes. Run it again whenever you like — it
reuses the daemon that's already up.

Messages are in English; they switch to Vietnamese when `LANG` starts with `vi`.

> Open it at `localhost`; don't type `127.0.0.1` by hand. Browsers treat those as
> two separate origins with separate permissions, so via the IP you'd have to
> grant microphone access again — and until you do, the 🎤 button hears nothing
> and says nothing about why.

Prefer double-clicking an icon to typing a command:

```bash
./scripts/make-app.sh     # creates ~/Applications/Agent Office.app
```

**Linux** — systemd `--user` service, starts at boot:

```bash
./scripts/install-ubuntu.sh
```

**Windows** — in PowerShell, from the repo directory:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

> `start.ps1` **parses and dry-runs clean on pwsh 7.6.3 (macOS)**: no syntax
> errors, and with the daemon already running the whole non-Windows path
> completes (check deps → `npm run build` → wait for the port → exit 0). The
> Windows-only parts have **not been run on real Windows**: `Start-ScheduledTask`
> registering and starting the daemon, `Start-Process` opening the browser, and
> x86 performance. `install-daemon-service.ps1`, which it calls, *has* been
> verified on real Windows 11 — see [windows-port.md](windows-port.md). On
> Windows, treat the first run as the test: success prints `Agent Office -> ...`
> and opens a browser.

## From a packed tarball (npx package)

The repo root is also an npm package: the daemon plus a prebuilt renderer, started
by one command that runs in the foreground and opens the browser. It installs **no**
background service unless you pass `--install-service`.

**It is not published to npm yet** (the name is still open), so build and install a
tarball yourself:

```bash
npm --prefix packages/renderer ci   # once
npm pack                            # builds the renderer, writes <name>-<version>.tgz
mkdir /tmp/ao && cd /tmp/ao
npm install /path/to/<name>-<version>.tgz
./node_modules/.bin/waitchime --port 8787
```

Options: `--port N` (default 8787), `--no-open`, `--install-service [--yes]`, `--help`.
`waitchime doctor|backup|...` (or `ao doctor|backup|...`, installed alongside; if another global package already owns an `ao` command, `npm i -g` stops with EEXIST, and `waitchime <verb>` does the same job) runs the `ao` CLI (`update` only works on a
git clone; for the package use `npm i -g waitchime@latest`). Its workspace
(the PM's session file) lives in `~/.agent-office/workspace`, not inside the
package; `--install-service` writes that location into the service definition
too. If the port is already serving Agent Office it says so instead of starting a
second daemon. If a service from another copy (say a clone) is installed, the
question names it and says it will be replaced.
`--install-service` refuses to run from npm's temporary `npx` cache, because the
service would point at a folder npm later deletes; install globally first.

Checked on macOS only, from a tarball, with a throwaway `HOME` and a port other than
8787. The `--install-service` path has not been run.

## What runs where

| | macOS | Windows |
|---|---|---|
| Daemon | launchd `com.agentoffice.daemon`, starts at login, restarts itself if it dies | Scheduled Task `AgentOfficeDaemon` |
| Daemon log | `~/Library/Logs/agent-office-daemon.log` | `%LOCALAPPDATA%\agent-office\agent-office-daemon.log` |
| Log when launched from the `.app` | `~/Library/Logs/agent-office-app.log` | — |
| App | `http://localhost:8787` — **one process, one port**: the daemon also serves the build | same as macOS |

It listens on `127.0.0.1` only and is not exposed to the network. To let other
people on your network in (with tokens and roles), and for the full install /
update / backup / uninstall guide, see [onprem.md](onprem.md). Before you change
the bind address by hand, read [SECURITY.md](../SECURITY.md).

## When something breaks

**A 404 or a blank page.** `packages/renderer/dist` hasn't been built. Run
`./scripts/start.sh` — it always builds. This is the reason that script exists:
`install-daemon-service.sh` only installs a service that serves `dist/`; it does
not build anything itself.

**The office still shows old code after you changed something.** Same cause. The
daemon reads files from disk per request, so once `start.sh` finishes building it
serves the new bundle immediately, with no restart. But if you build by hand and
forget, the daemon happily returns **200 with the old build** and looks perfectly
healthy. It has no way to tell you.

**Settings says "Disconnected" in live mode.** The daemon really is down. Check
the log in the table above, then bring it back with `./scripts/start.sh`.

**Shadows disappeared on their own.** Deliberate: if the machine drops below
20 fps for more than three seconds, the office sheds shadows to stay smooth and
does not turn them back on until you reload. Measured at 3 fps on a Windows ARM
VM with no GPU acceleration. Reloading the page brings them back.

**The machine has no WebGL.** The app still works — Board, Activity, Spend and
Settings are all normal; only the 3D office is replaced by an explanation.

## A demo with no daemon

Add `?mock=1` for a scripted scenario that opens straight into the office, with
no daemon and no real sessions. Useful for showing someone the product before
they connect anything.

In this mode Board / Activity / Spend have **no data** — by design, since there
is no daemon to ask.

The real thing is the opposite: open `http://localhost:8787` with no query
parameters and your running agent sessions appear as characters within seconds.

## Uninstalling

```bash
./scripts/install-daemon-service.sh uninstall     # macOS
rm -rf ~/Applications/Agent\ Office.app           # if you created the .app
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1 uninstall
```

Then delete the repo. Nothing lives outside the repo, the service, and the log
files listed above.
