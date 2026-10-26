// lane L1: `update` — bring an installed Agent Office to the latest version.
//   clean-tree check → backup of the agent-office home → git pull --ff-only →
//   npm ci (daemon, renderer) → renderer build → restart the service → health check.
// It refuses rather than guesses: a dirty tree, a non-fast-forward pull and a
// failed build all stop BEFORE the running daemon is touched. If the install or
// build fails after the pull, the previous version is put back: code reset to the
// starting commit, and node_modules renamed back (kept as node_modules.prev during
// the update), so the restore needs no network — the usual reason an install fails.

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
        // The task runs `cmd /c node …`; make sure the old node.exe is really gone (matched by
        // its script path, so ao.mjs itself and other node programs are left alone) before the new one starts.
        `Stop-ScheduledTask -TaskName ${task} -ErrorAction SilentlyContinue; ` +
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
          `Where-Object { $_.CommandLine -like '*packages\\daemon\\src\\index.js*' } | ` +
          `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` +
          `Start-Sleep -Seconds 1; Start-ScheduledTask -TaskName ${task}`,
      ],
    };
  }
  return { cmd: "systemctl", args: ["--user", "restart", SERVICE.linux] };
}

/**
 * npm is npm.cmd on Windows, and a .cmd shim can only be spawned through a shell. Nothing
 * else may use one: cmd.exe would swallow the `|` and quotes in the PowerShell restart script.
 */
export function needsShell(cmd, platform = process.platform) {
  return platform === "win32" && cmd === "npm";
}

export function defaultRun(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    shell: needsShell(cmd),
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
 * Put a finished build into place. Built beside `dist` and swapped in only now, so a
 * failed build never empties the folder the running daemon is serving.
 */
export function swapDist(rendererDir) {
  const dist = path.join(rendererDir, "dist");
  const next = path.join(rendererDir, "dist.next");
  const old = path.join(rendererDir, "dist.old");
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dist)) fs.renameSync(dist, old);
  try {
    fs.renameSync(next, dist);
  } catch (error) {
    if (fs.existsSync(old)) fs.renameSync(old, dist);
    throw error;
  }
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // the swap itself succeeded; a locked leftover (Windows) must not fail the update
  }
}

/** node_modules ⇄ node_modules.prev, so a failed `npm ci` can be undone offline. */
const realFs = {
  exists: (p) => fs.existsSync(p),
  rename: (a, b) => fs.renameSync(a, b),
  rm: (p) => fs.rmSync(p, { recursive: true, force: true }),
};

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
  swap = swapDist,
  fsx = realFs,
  cleanup = (dir) => fs.rmSync(path.join(dir, "dist.next"), { recursive: true, force: true }),
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
      `npm run build   (in ${rendererDir}; built beside dist/ and swapped in only if it succeeds)`,
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

  const modules = (dir) => path.join(dir, "node_modules");
  const prev = (dir) => path.join(dir, "node_modules.prev");
  const installed = []; // dirs whose node_modules we moved aside

  // The tree was verified clean. `--keep` refuses (instead of discarding) if the user
  // edited a tracked file meanwhile. node_modules comes back by rename, not by npm ci.
  const restorePrevious = (why) => {
    cleanup(rendererDir);
    try {
      for (const dir of installed) {
        if (!fsx.exists(prev(dir))) continue; // there was no install before: nothing to put back
        fsx.rm(modules(dir));
        fsx.rename(prev(dir), modules(dir));
      }
    } catch (error) {
      why += `\n(could not move the previous files back: ${error.message})`;
    }
    const ok = run("git", ["reset", "--keep", from], { cwd: repo }).status === 0;
    if (ok) return `${why}\nThe previous version (${from.slice(0, 7)}) has been restored and the running daemon was not touched.`;
    return (
      `${why}\nRestoring the previous version did not complete. By hand, in ${repo}:\n` +
      `  git reset --hard ${from}\n  npm ci --prefix packages/daemon\n  npm ci --prefix packages/renderer\n  node scripts/ao.mjs doctor\n` +
      "Your data is in the backup listed above."
    );
  };
  for (const [dir, label] of [[daemonDir, "daemon"], [rendererDir, "renderer"]]) {
    log(`Installing ${label} dependencies...`);
    if (fsx.exists(modules(dir))) {
      fsx.rm(prev(dir));
      fsx.rename(modules(dir), prev(dir));
    }
    installed.push(dir);
    const r = run("npm", ["ci"], { cwd: dir });
    if (r.status !== 0) throw new UpdateError(restorePrevious(`npm ci failed in packages/${label}.\n${r.stderr.trim().slice(-600)}`));
  }
  log("Building the renderer...");
  cleanup(rendererDir);
  const build = run("npm", ["run", "build", "--", "--outDir", "dist.next"], { cwd: rendererDir });
  if (build.status !== 0) throw new UpdateError(restorePrevious(`renderer build failed.\n${build.stderr.trim().slice(-600)}`));
  try {
    swap(rendererDir);
  } catch (error) {
    throw new UpdateError(restorePrevious(`could not put the new build in place (${error.message}).`));
  }
  for (const dir of installed) fsx.rm(prev(dir)); // the new install works: the old one can go

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
