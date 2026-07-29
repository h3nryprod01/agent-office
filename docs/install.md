# Install and run

Everything you need to run Agent Office on your own machine. Requires **Node 20+**
and nothing else.

## Running it

**macOS** — one command, from a fresh clone or on the morning of a demo:

```bash
./scripts/start.sh
```

It installs dependencies if they are missing, rebuilds the renderer, sets the
daemon up if it isn't running, and opens **http://localhost:8787**. Run it again
whenever you like — it reuses the daemon that's already up.

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

## What runs where

| | macOS | Windows |
|---|---|---|
| Daemon | launchd `com.agentoffice.daemon`, starts at login, restarts itself if it dies | Scheduled Task `AgentOfficeDaemon` |
| Daemon log | `~/Library/Logs/agent-office-daemon.log` | `%LOCALAPPDATA%\agent-office\agent-office-daemon.log` |
| Log when launched from the `.app` | `~/Library/Logs/agent-office-app.log` | — |
| App | `http://localhost:8787` — **one process, one port**: the daemon also serves the build | same as macOS |

It listens on `127.0.0.1` only and is not exposed to the network. Before you
change that, read [SECURITY.md](../SECURITY.md).

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
