// R14: every process.platform branch lives HERE, so the rest of the daemon
// never sprinkles `if (process.platform === "win32")` around. Each function
// takes `platform`/`env` as injected args (defaulting to the real ones) so the
// win32 code paths are unit-tested on macOS without executing any Windows
// command — we only assert the {cmd, args} they would build.
//
// Untestable on macOS (and therefore NOT in this file's contract): that the
// commands actually succeed on a real Windows box. docs/windows-port.md lists
// what a human must verify on Windows.

import path from "node:path";
import os from "node:os";

/** @param {string} [platform] defaults to the real platform */
export function isWindows(platform = process.platform) {
  return platform === "win32";
}

/** @param {string} [platform] defaults to the real platform */
export function isLinux(platform = process.platform) {
  return platform === "linux";
}

/**
 * Filenames to try for a CLI binary. npm-installed CLIs land as `claude.cmd`
 * (a shim) on Windows, not a bare `claude` — so a PATH scan that only checks
 * the bare name misses them. Order matters only as a tie-break; accessSync in
 * harness-probe checks whichever exists first.
 * @param {string} bin
 * @param {string} [platform]
 */
export function binCandidates(bin, platform = process.platform) {
  if (!isWindows(platform)) return [bin];
  return [bin, `${bin}.cmd`, `${bin}.exe`, `${bin}.ps1`];
}

/**
 * Dirs a bare-PATH scan should also probe. The daemon may run under a service
 * manager with a sparse PATH (launchd on macOS; a Scheduled Task on Windows),
 * so we re-add where global CLIs actually live.
 *
 * Windows: npm's global bin (%APPDATA%\npm), the daemon's own node dir
 * (nvm/volta install CLIs as siblings of node), and a ~/.local/bin equivalent
 * under %USERPROFILE%. macOS/other: node dir + Homebrew + /usr/local + ~/.local.
 * @param {string} [platform]
 * @param {Record<string,string>} [env]
 */
export function commonBinDirs(platform = process.platform, env = process.env) {
  const nodeDir = path.dirname(process.execPath);
  if (isWindows(platform)) {
    return [
      nodeDir,
      path.join(env.APPDATA ?? "", "npm"),
      path.join(env.USERPROFILE ?? "", ".local", "bin"),
    ];
  }
  return [
    nodeDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
  ];
}

/**
 * Build the shell-out to reveal/open a file in the platform file manager.
 * macOS: `open -R <path>` (reveal) / `open <path>`. Windows: `explorer
 * /select,<path>` (reveal) / `explorer <path>`. The comma form `/select,C:\x`
 * is explorer's documented select syntax.
 * @param {string} realPath already realpath-resolved
 * @param {boolean} reveal
 * @param {string} [platform]
 * @returns {{cmd: string, args: string[]}}
 */
export function revealCommand(realPath, reveal, platform = process.platform) {
  if (isWindows(platform)) {
    return { cmd: "explorer", args: [reveal ? `/select,${realPath}` : realPath] };
  }
  if (isLinux(platform)) {
    return { cmd: "xdg-open", args: [reveal ? path.dirname(realPath) : realPath] };
  }
  return { cmd: "open", args: reveal ? ["-R", realPath] : [realPath] };
}

/**
 * Build the shell-out for a desktop notification. macOS returns a `{cmd:null}`
 * marker — notifier.js keeps its existing terminal-notifier→osascript path
 * (with Homebrew-path probing), because that fallback chain is already correct
 * and a single {cmd,args} can't express it. Windows returns a PowerShell
 * -Command that raises a NotifyIcon balloon (no extra module; System.Windows.Forms
 * ships with Windows PowerShell).
 *
 * ponytail: NotifyIcon balloon disappears if the process exits too fast, so we
 * Start-Sleep before Dispose. Ceiling = ugly transient icon + no click action;
 * upgrade path = WinRT toast (deferred, see docs/windows-port.md).
 * @param {{title?: string, subtitle?: string, message?: string, url?: string}} n
 * @param {string} [platform]
 * @returns {{cmd: string|null, args: string[]}}
 */
export function notifyCommand({ title = "", subtitle = "", message = "" } = {}, platform = process.platform) {
  if (isLinux(platform)) {
    return { cmd: "notify-send", args: ["-a", "Agent Office", title, message] };
  }
  if (!isWindows(platform)) {
    return { cmd: null, args: [] };
  }
  // PowerShell single-quoted strings: the only char needing escape is ' → ''.
  const q = (s) => String(s ?? "").replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    `$n.ShowBalloonTip(6000, '${q(title)}', '${q(message)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Seconds 6",
    "$n.Dispose()",
  ].join("; ");
  return { cmd: "powershell", args: ["-NoProfile", "-Command", script] };
}

/**
 * Node spawn options. A `.cmd`/`.bat` shim on Windows can only be spawned with
 * `shell: true` (Node refuses to spawn shell scripts directly); everywhere else
 * the bare binary spawns fine with no options.
 * @param {string} [platform]
 */
export function cliSpawnOptions(platform = process.platform) {
  return isWindows(platform) ? { shell: true } : {};
}
