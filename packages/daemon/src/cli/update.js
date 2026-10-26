// lane L1: `update` — bring an installed Agent Office to the latest version.
//   clean-tree check → backup of the agent-office home → git pull --ff-only →
//   npm ci (daemon, renderer) → renderer build → restart the service → health check.
// It refuses rather than guesses: a dirty tree, a non-fast-forward pull and a
// failed build all stop BEFORE the running daemon is touched, and the error
// carries the exact commands to go back. No automatic rollback — a half-guessed
// rollback on a customer's machine is worse than a clear instruction.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createBackup } from "./backup.js";

const SERVICE = { darwin: "com.agentoffice.daemon", linux: "agent-office-daemon", win32: "AgentOfficeDaemon" };

/** The command that restarts the installed background service on this platform. */
export function restartCommand(platform = process.platform, uid = process.getuid?.() ?? 501) {
  if (platform === "darwin") return { cmd: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${SERVICE.darwin}`] };
  if (platform === "win32") {
    const task = SERVICE.win32;
    return {
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `Stop-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName ${task}`,
      ],
    };
  }
  return { cmd: "systemctl", args: ["--user", "restart", SERVICE.linux] };
}

export function defaultRun(cmd, args, opts = {}) {
  // npm is npm.cmd on Windows; a .cmd shim can only be spawned through a shell
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.inherit ? "inherit" : "pipe",
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? String(res.error ?? "") };
}

/** Poll until the daemon answers on loopback, or give up. */
export async function waitForDaemon(port, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/transcript?limit=1`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

class UpdateError extends Error {}

/**
 * @returns {Promise<{status: "updated" | "up-to-date" | "dry-run", from?: string, to?: string}>}
 */
export async function runUpdate({
  repo,
  home,
  platform = process.platform,
  uid,
  port = 8787,
  dryRun = false,
  run = defaultRun,
  backup = createBackup,
  health = waitForDaemon,
  homeExists = (p) => fs.existsSync(p),
  log = console.log,
}) {
  const daemonDir = path.join(repo, "packages", "daemon");
  const rendererDir = path.join(repo, "packages", "renderer");
  const restart = restartCommand(platform, uid);
  const restartLine = [restart.cmd, ...restart.args].join(" ");

  if (dryRun) {
    log("Dry run — nothing will be executed. `update` would:");
    [
      "check the working tree is clean (git status --porcelain)",
      `back up ${home}`,
      "git pull --ff-only",
      `npm ci   (in ${daemonDir})`,
      `npm ci   (in ${rendererDir})`,
      `npm run build   (in ${rendererDir})`,
      restartLine,
      `wait for http://127.0.0.1:${port} to answer`,
    ].forEach((step, i) => log(`  ${i + 1}. ${step}`));
    return { status: "dry-run" };
  }

  const git = (...args) => run("git", args, { cwd: repo });

  const status = git("status", "--porcelain");
  if (status.status !== 0) throw new UpdateError(`${repo} is not a git checkout — update needs the cloned repository.`);
  if (status.stdout.trim() !== "") {
    throw new UpdateError(
      "This checkout has local changes, so `update` will not pull over them.\n" +
        "  See them:    git status\n  Keep them:   git stash   (then run update again)",
    );
  }
  const from = git("rev-parse", "HEAD").stdout.trim();

  if (homeExists(home)) {
    const { archive } = backup({ home });
    log(`Backed up ${home} -> ${archive}`);
  }

  const pull = git("pull", "--ff-only");
  if (pull.status !== 0) {
    throw new UpdateError(`git pull failed — nothing was changed.\n${pull.stderr.trim()}\n  (a non-fast-forward means this checkout has diverged from upstream)`);
  }
  const to = git("rev-parse", "HEAD").stdout.trim();
  if (to === from) {
    log("Already up to date.");
    return { status: "up-to-date", from, to };
  }
  log(`Updated ${from.slice(0, 7)} -> ${to.slice(0, 7)}`);

  const rollback =
    `\nThe running daemon was NOT restarted. To go back:\n  git checkout ${from}\n  (then run the start script again)\n` +
    "Your data is in the backup listed above.";
  for (const [dir, label] of [[daemonDir, "daemon"], [rendererDir, "renderer"]]) {
    log(`Installing ${label} dependencies...`);
    const r = run("npm", ["ci"], { cwd: dir });
    if (r.status !== 0) throw new UpdateError(`npm ci failed in packages/${label}.\n${r.stderr.trim().slice(-600)}${rollback}`);
  }
  log("Building the renderer...");
  const build = run("npm", ["run", "build"], { cwd: rendererDir });
  if (build.status !== 0) throw new UpdateError(`renderer build failed.\n${build.stderr.trim().slice(-600)}${rollback}`);

  log("Restarting the service...");
  const restarted = run(restart.cmd, restart.args);
  if (restarted.status !== 0) {
    throw new UpdateError(
      `The new version is built, but the service could not be restarted (${restarted.stderr.trim() || "no service installed?"}).\n` +
        `  Restart it yourself:  ${restartLine}\n  or run the start script once to install the service.`,
    );
  }
  if (!(await health(port))) {
    throw new UpdateError(`Restarted, but the daemon is not answering on port ${port}. Check its log (docs/onprem.md, "Logs").`);
  }
  log("Done — Agent Office is running the new version.");
  return { status: "updated", from, to };
}
