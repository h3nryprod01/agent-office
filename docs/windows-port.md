# Windows port (R14) — daemon only

Agent Office's daemon runs on Windows 11. The renderer runs in a browser, so it
is already cross-platform. This is the **first** Windows port: 4 macOS "glue"
points were made platform-aware, the rest of the core already used `os.homedir()`
+ `path` (so `~/.claude` → `%USERPROFILE%\.claude` automatically).

**Status:** **verified on a real Windows 11 (ARM, build 26200) VM on 2026-07-14**
— daemon boots native, the Scheduled Task registers, `GET /harnesses` finds
`claude.cmd`, `POST /open` opens Explorer, the PowerShell balloon fires, and
`probeLoggedIn` spawns `claude.cmd` (shell:true) successfully. Logic is also
unit-tested on macOS by injecting `platform`/`env` (see
`packages/daemon/test/platform.test.js`). What remains is the **customer step**:
a real Claude Code install + login and an end-to-end PM chat reply (the VM used a
stub `claude.cmd`), plus scheduler auto-start/restart under a real desktop
session. See the checklist below.

## Install on Windows 11

1. **Node 20+** — install from nodejs.org (or `winget install OpenJS.NodeJS.LTS`).
2. **Claude Code** — `npm install -g @anthropic-ai/claude-code` (this drops
   `claude.cmd` under `%APPDATA%\npm`, which npm adds to your PATH).
   Then `claude` to log in once.
3. **Get the repo** — `git clone` it somewhere, then in the repo root:
   ```powershell
   cd packages\daemon
   npm install
   cd ..\..
   ```
4. **Install the daemon as a Scheduled Task** (starts at logon, restarts on
   crash, logs to `%LOCALAPPDATA%\agent-office\agent-office-daemon.log`):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1
   Start-ScheduledTask -TaskName AgentOfficeDaemon   # start now without re-login
   ```
   Uninstall: `... install-daemon-service.ps1 uninstall`.

The daemon binds `127.0.0.1:8787`. Open the renderer (Vite dev `:5199`, or the
served build) and it connects to the daemon as on macOS.

## What changed for Windows

All `process.platform` branching lives in one file: `packages/daemon/src/platform.js`
(pure functions, each takes `platform`/`env` so the win32 paths are testable on
macOS without running a Windows command).

- `harness-probe.js` — `checkInstalled` now tries `binCandidates` (`claude`,
  `claude.cmd`, `.exe`, `.ps1`) per dir, and probes `%APPDATA%\npm` +
  `%USERPROFILE%\.local\bin`. `probeLoggedIn` spawns with `shell:true`.
- `outputs.js` — `POST /open` uses `revealCommand` (`explorer /select,<path>`
  instead of `open -R`).
- `notifier.js` — Windows → PowerShell `NotifyIcon` balloon; macOS path unchanged.
- `chat-session.js` — spawns `claude` with `shell:true` (required for the
  `.cmd` shim).
- `scripts/install-daemon-service.ps1` — Scheduled Task sibling of the macOS
  launchd `.sh` (kept side-by-side; the `.sh` is untouched).

## Verified on a real Windows 11 VM (GLM, 2026-07-14)

- [x] `install-daemon-service.ps1` registers the task (the `cmd /c`
      quote/redirect pattern has no syntax error) and the daemon boots native
      (all routes + tailers + WS server on 8787).
- [x] `GET /harnesses` reports Claude `installed: true` — `binCandidates`
      finds `claude.cmd` under `%APPDATA%\npm`.
- [x] `GET /harnesses?probe=claude` → `loggedIn: true` — `probeLoggedIn`
      spawns `claude.cmd` with `shell:true` (a stub that exits 0).
- [x] `POST /open` → 200, launches `explorer /select,C:\…` (after the
      explorer-exit-1 fix).
- [x] The PowerShell balloon script is valid and runs (exit 0) on PS 5.1.

## Còn lại — bước của khách (real login / desktop session)

The VM used a **stub** `claude.cmd` (real Claude Code took 9+ min to install on
ARM) and ran the daemon directly (no interactive desktop after a hard reset), so
these need the customer's actual machine:

- [ ] Real `claude` install + `claude` login, then an end-to-end PM chat
      (`POST /chat`) that streams a real reply.
- [ ] `%LOCALAPPDATA%\agent-office\agent-office-daemon.log` receives output when
      started **via the Scheduled Task** (not just `node` directly).
- [ ] The task auto-starts at logon and restarts after a crash (RestartCount 3 /
      RestartInterval 1m) under a real interactive desktop session.

## Not in this port (deferred)

WinRT toast notifications (the balloon is the quick version), a packaged
`.exe` (Electron/Tauri), Windows TTS voices, and Codex/Gemini harness
verification on Windows.
