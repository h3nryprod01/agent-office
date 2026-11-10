# Install the Agent Office daemon as a Windows Scheduled Task: starts at logon,
# restarts on crash (the launchd KeepAlive analog), logs to %LOCALAPPDATA%.
# This is the Windows sibling of install-daemon-service.sh (macOS launchd).
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1 -Yes     (skip the question)
#   powershell -ExecutionPolicy Bypass -File scripts\install-daemon-service.ps1 uninstall
#
# R14 NOTE: not linted on macOS (no pwsh). Windows PowerShell 5.1 ships with
# Windows 10/11, so no extra install is needed on the target machine. Verify on
# a real Windows box — see docs/windows-port.md.

#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Mode = "install",
    [string]$TaskName = "AgentOfficeDaemon",
    # Answers the "install a background task?" question.
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
$Script = Join-Path $Repo "packages\daemon\src\index.js"
$Node = (Get-Command node -ErrorAction Stop).Source
$LogDir = Join-Path $env:LOCALAPPDATA "agent-office"
$Log = Join-Path $LogDir "agent-office-daemon.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($Mode -eq "uninstall") {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "uninstalled $TaskName"
    exit 0
}

# A task from another copy (e.g. a git clone) may exist under this name: installing replaces it.
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$ReplaceEn = ""
$ReplaceVi = ""
if ($Existing -and $Existing.Actions[0].WorkingDirectory -and ($Existing.Actions[0].WorkingDirectory -ne $Repo)) {
    $ReplaceEn = " This will REPLACE the task currently running from $($Existing.Actions[0].WorkingDirectory)."
    $ReplaceVi = " Viec nay se THAY tac vu dang chay tu $($Existing.Actions[0].WorkingDirectory)."
}
if (-not (Confirm-Yes ("Install Agent Office as a scheduled task that starts at logon and restarts on crash?" + $ReplaceEn) ("Cai Agent Office thanh tac vu tu chay khi dang nhap va tu khoi dong lai khi loi?" + $ReplaceVi))) {
    $Fg = Join-Path $Repo "packages\daemon\src\index.js"
    [Console]::Error.WriteLine((Say "Not installed. To run in the foreground instead: node $Fg" "Chua cai. Muon chay o tien canh: node $Fg"))
    exit 1
}

# Idempotent: drop an existing task before re-registering (re-run to update).
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# ScheduledTask runs the action directly (not via a shell), so to mirror the
# macOS plist's StandardOutPath/StandardErrorPath we wrap in `cmd /c` and
# redirect both streams to the log. The double leading/trailing quote is the
# documented cmd.exe /c pattern: cmd strips the OUTER pair and keeps the inner
# quoted paths + `>`/`2>&1` redirection intact.
# R14: NOT linted/run on macOS — verify the quoting/redirect on Windows.
# AGENT_OFFICE_REPO (set by `<package> --install-service`) keeps the PM workspace out of the package folder.
$EnvPrefix = ""
if ($env:AGENT_OFFICE_REPO) { $EnvPrefix = 'set "AGENT_OFFICE_REPO=' + $env:AGENT_OFFICE_REPO + '" && ' }
$Argument = '/c "' + $EnvPrefix + '"' + $Node + '" --max-old-space-size=768 "' + $Script + '" > "' + $Log + '" 2>&1"'
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $Argument -WorkingDirectory $Repo
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RestartCount/RestartInterval = restart-on-crash (KeepAlive analog). The daemon
# must be long-running, so ExecutionTimeLimit 0 = unlimited and DontStopOnIdleEnd
# keeps it alive. AllowStartIfOnBatteries/DontStopIfGoingOnBatteries = laptops.
$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

# Interactive logon (not S4U) so the task inherits the user's PATH — that's where
# npm puts claude.cmd (%APPDATA%\npm). RunLevel Limited = no admin needed.
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Agent Office daemon (kept alive, starts at logon)" | Out-Null

Write-Output "installed $TaskName (node: $Node, repo: $Repo, log: $Log)"
Write-Output "start now:  Start-ScheduledTask -TaskName '$TaskName'   (or just re-logon)"
Write-Output "tail logs:  Get-Content -Wait '$Log'"
