# Run Agent Office: one command, from a fresh clone or on demo morning.
# Builds the renderer, makes sure the daemon is up, opens the office.
# The Windows sibling of start.sh (macOS).
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#
# Parsed and dry-run on pwsh 7.6.3 (macOS): 0 syntax errors, and with the daemon
# already up the whole non-Windows path runs clean end to end — deps check,
# `npm run build` (built in ~1s), the port wait, exit 0. What has NOT run on any
# Windows box is the Windows-only half: Start-ScheduledTask actually registering
# and starting the daemon, Start-Process opening the browser, and real x86 perf.
# install-daemon-service.ps1 (which this calls) WAS verified on a real Windows 11
# VM — see docs/windows-port.md. On Windows the first run is still the test: it
# should print "Agent Office -> ..." and open the office.

#Requires -Version 5.1
[CmdletBinding()]
param(
    # lane L1: `start.ps1 doctor|update|backup|restore|lan|token|report|approvals [options]` runs the ao CLI instead of starting
    [Parameter(Position = 0)][string]$Command = "start",
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest,
    # Must match install-daemon-service.ps1's default; that script registers the
    # task under this name.
    [string]$TaskName = "AgentOfficeDaemon",
    # Answers yes to "install the daemon as a background task?" (otherwise it asks).
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

# Messages are English; Vietnamese when LANG starts with "vi" (or Windows is set to Vietnamese).
function Test-Vi { return (($env:LANG -like "vi*") -or ((Get-Culture).Name -like "vi*")) }
function Say([string]$En, [string]$Vi) { if (Test-Vi) { return $Vi } else { return $En } }
function Confirm-Yes([string]$En, [string]$Vi) {
    if ($Yes) { return $true }
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        [Console]::Error.WriteLine((Say "$En (no terminal: assuming no; re-run with -Yes to agree)" "$Vi (khong co terminal: coi nhu khong; chay lai voi -Yes de dong y)"))
        return $false
    }
    $ans = Read-Host (Say "$En [y/N]" "$Vi [c/K]")
    return ($ans -match "^[yYcC]")
}

$Repo = (Resolve-Path "$PSScriptRoot\..").Path
# localhost, KHÔNG phải 127.0.0.1: trình duyệt coi đây là hai origin riêng và
# cấp quyền riêng, nên mở bằng IP thì quyền microphone đã cấp cho localhost
# không áp dụng — nhận giọng nói chết im lặng.
$Url = "http://localhost:8787"

# lane L1: operations verbs, and a readiness check before anything is installed
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error (Say "Node.js 20+ is required: winget install OpenJS.NodeJS.LTS" "Can Node.js 20+: winget install OpenJS.NodeJS.LTS")
    exit 1
}
if ($Command -in @("doctor", "update", "backup", "restore", "lan", "token", "report", "approvals")) {
    & node (Join-Path $Repo "scripts\ao.mjs") $Command @Rest
    exit $LASTEXITCODE
}
if ($Command -ne "start") {
    [Console]::Error.WriteLine("unknown command '$Command' - use: doctor, update, backup, restore, lan, token, report, approvals (or no argument to start)")
    exit 2
}
& node (Join-Path $Repo "scripts\ao.mjs") doctor --preflight
if ($LASTEXITCODE -ne 0) { exit 1 }

function Test-Daemon {
    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

foreach ($pkg in @("daemon", "renderer")) {
    if (-not (Test-Path (Join-Path $Repo "packages\$pkg\node_modules"))) {
        npm --prefix (Join-Path $Repo "packages\$pkg") install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed for $pkg" }
    }
}

# Always rebuild. A stale dist is the one failure the daemon cannot report: it
# serves last week's build with a cheerful 200 and looks perfectly healthy.
# `tsc && vite build` also means a type error stops us here, before a browser
# window opens on the old bundle.
npm --prefix (Join-Path $Repo "packages\renderer") run build
if ($LASTEXITCODE -ne 0) { throw "renderer build failed - not opening a browser on a stale bundle" }

$DaemonProc = $null
if (-not (Test-Daemon)) {
  if (Confirm-Yes "No daemon is running. Install it as a background task that starts at logon?" "Chua co daemon nao chay. Cai no lam tac vu nen tu chay khi dang nhap?") {
    & (Join-Path $Repo "scripts\install-daemon-service.ps1") -Yes
    # Windows differs from macOS here, and quietly. launchd's RunAtLoad starts the
    # daemon the moment it is bootstrapped; Register-ScheduledTask only arms a
    # logon trigger, so without this line the office would appear at the user's
    # next logon and the wait below would time out for no visible reason.
    Start-ScheduledTask -TaskName $TaskName
  } else {
    Write-Output (Say "Running the daemon in this window; Ctrl+C stops it." "Chay daemon ngay trong cua so nay; Ctrl+C de dung.")
    $DaemonProc = Start-Process node -ArgumentList @("--max-old-space-size=768", (Join-Path $Repo "packages\daemon\src\index.js")) -NoNewWindow -PassThru
  }
}

foreach ($attempt in 1..50) {
    if (Test-Daemon) { break }
    Start-Sleep -Milliseconds 200
}

if (-not (Test-Daemon)) {
    $Log = Join-Path $env:LOCALAPPDATA "agent-office\agent-office-daemon.log"
    Write-Error (Say "daemon is silent at $Url - log: $Log" "daemon im lang o $Url - log: $Log")
    exit 1
}

Write-Output "Agent Office -> $Url"
Start-Process $Url
if ($DaemonProc) { Wait-Process -Id $DaemonProc.Id }
