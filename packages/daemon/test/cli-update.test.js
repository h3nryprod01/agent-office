// lane L1: `update` = backup, pull, install, build, restart. Run against a fake
// `run` so the order, the refusal cases and the rollback hint are all checked
// without touching git, npm or a service manager.

import test from "node:test";
import assert from "node:assert/strict";
import { runUpdate, restartCommand, needsShell, commandLine } from "../src/cli/update.js";

function harness({ platform = "linux", dirty = false, head = ["aaa111", "bbb222"], failOn = null, healthy = true } = {}) {
  const calls = [];
  let revs = 0;
  const run = (cmd, args, opts = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, cwd: opts.cwd });
    if (failOn && line.includes(failOn)) return { status: 1, stdout: "", stderr: "boom" };
    if (line === "git status --porcelain") return { status: 0, stdout: dirty ? " M file.js\n" : "" };
    if (line === "git rev-parse HEAD") return { status: 0, stdout: `${head[Math.min(revs++, head.length - 1)]}\n` };
    return { status: 0, stdout: "" };
  };
  const logs = [];
  const backups = [];
  const swaps = [];
  const fsOps = [];
  return {
    calls,
    logs,
    backups,
    swaps,
    fsOps,
    opts: {
      repo: "/repo",
      home: "/home/x/.agent-office",
      platform,
      uid: 501,
      port: 8787,
      run,
      backup: (a) => (backups.push(a), { archive: "/b/x.tar.gz" }),
      health: async () => healthy,
      swap: (dir) => swaps.push(dir),
      fsx: {
        exists: () => true,
        rename: (a, b) => fsOps.push(`mv ${a} ${b}`),
        rm: (p) => fsOps.push(`rm ${p}`),
      },
      cleanup: () => {},
      log: (m) => logs.push(m),
      homeExists: () => true,
    },
  };
}

test("happy path: clean tree → backup → pull → npm ci x2 → build → restart → health, in that order", async () => {
  const h = harness();
  const result = await runUpdate(h.opts);
  assert.equal(result.status, "updated");
  assert.deepEqual([result.from, result.to], ["aaa111", "bbb222"]);
  assert.equal(h.backups.length, 1);
  assert.deepEqual(
    h.calls.map((c) => c.line),
    [
      "git status --porcelain",
      "git rev-parse HEAD",
      "git pull --ff-only",
      "git rev-parse HEAD",
      "npm ci",
      "npm ci",
      "npm run build -- --outDir dist.next",
      "systemctl --user restart agent-office-daemon",
    ],
  );
  assert.deepEqual(h.calls.filter((c) => c.line.startsWith("npm")).map((c) => c.cwd), [
    "/repo/packages/daemon",
    "/repo/packages/renderer",
    "/repo/packages/renderer",
  ]);
});

test("dirty working tree → refuses before pulling or backing up anything", async () => {
  const h = harness({ dirty: true });
  await assert.rejects(runUpdate(h.opts), /local changes/i);
  assert.equal(h.backups.length, 0);
  assert.ok(!h.calls.some((c) => c.line.includes("pull")));
});

test("already up to date → no install, no build, no restart", async () => {
  const h = harness({ head: ["same", "same"] });
  const result = await runUpdate(h.opts);
  assert.equal(result.status, "up-to-date");
  assert.deepEqual(h.calls.map((c) => c.line), ["git status --porcelain", "git rev-parse HEAD", "git pull --ff-only", "git rev-parse HEAD"]);
});

test("a failed pull stops cold and says nothing was changed", async () => {
  const h = harness({ failOn: "pull" });
  await assert.rejects(runUpdate(h.opts), /git pull failed/i);
  assert.ok(!h.calls.some((c) => c.line.startsWith("npm")));
});

test("build failure after the pull → previous version restored automatically (offline), no swap, no restart", async () => {
  const h = harness({ failOn: "run build" });
  await assert.rejects(runUpdate(h.opts), (error) => {
    assert.match(error.message, /build failed/i);
    assert.match(error.message, /restored/i);
    return true;
  });
  const lines = h.calls.map((c) => c.line);
  assert.ok(lines.includes("git reset --keep aaa111"), "back to the starting commit, same branch, never discarding edits made meanwhile");
  assert.equal(lines.filter((l) => l === "npm ci").length, 2, "no network needed to undo: node_modules comes back by rename");
  assert.ok(h.fsOps.some((o) => o.startsWith("mv ") && o.includes("node_modules.prev /repo/packages/daemon/node_modules")), "daemon node_modules restored");
  assert.ok(h.fsOps.some((o) => o.startsWith("mv ") && o.includes("node_modules.prev /repo/packages/renderer/node_modules")), "renderer node_modules restored");
  assert.deepEqual(h.swaps, [], "the served dist/ was never replaced");
  assert.ok(!lines.some((l) => l.includes("systemctl")), "never restart onto a broken build");
});

test("npm ci failing halfway (e.g. network down) restores the previous node_modules without any network", async () => {
  const h = harness();
  let ciCalls = 0;
  const run = h.opts.run;
  h.opts.run = (cmd, args, o) => (cmd === "npm" && args[0] === "ci" && ++ciCalls === 2 ? { status: 1, stdout: "", stderr: "ENOTFOUND" } : run(cmd, args, o));
  await assert.rejects(runUpdate(h.opts), /npm ci failed in packages\/renderer[\s\S]*restored/i);
  assert.equal(ciCalls, 2, "no third npm ci attempt");
  assert.ok(h.calls.some((c) => c.line === "git reset --keep aaa111"));
  assert.ok(h.fsOps.some((o) => o.includes("node_modules.prev /repo/packages/renderer/node_modules")));
});

test("if even the code reset fails, the error spells out the manual steps", async () => {
  const h = harness();
  const run = h.opts.run;
  h.opts.run = (cmd, args, o) => (args[0] === "run" || args[0] === "reset" ? { status: 1, stdout: "", stderr: "x" } : run(cmd, args, o));
  await assert.rejects(runUpdate(h.opts), /git reset --hard aaa111[\s\S]*npm ci --prefix packages\/daemon/);
});

test("on success the kept node_modules.prev copies are deleted", async () => {
  const h = harness();
  await runUpdate(h.opts);
  assert.ok(h.fsOps.filter((o) => o.startsWith("rm ") && o.endsWith("node_modules.prev")).length >= 2);
});

test("the new build is swapped in only after it succeeded, and before the restart", async () => {
  const h = harness();
  const order = [];
  const run = h.opts.run;
  h.opts.run = (cmd, args, o) => (order.push(cmd === "systemctl" ? "restart" : null), run(cmd, args, o));
  h.opts.swap = () => order.push("swap");
  await runUpdate(h.opts);
  assert.ok(order.indexOf("swap") !== -1 && order.indexOf("swap") < order.indexOf("restart"));
});

test("restart commands per platform", () => {
  assert.deepEqual(restartCommand("darwin", 501), { cmd: "launchctl", args: ["kickstart", "-k", "gui/501/com.agentoffice.daemon"] });
  assert.deepEqual(restartCommand("linux"), { cmd: "systemctl", args: ["--user", "restart", "agent-office-daemon"] });
  const win = restartCommand("win32");
  assert.equal(win.cmd, "powershell");
  const script = win.args.join(" ");
  assert.match(script, /Stop-ScheduledTask.*AgentOfficeDaemon.*Start-ScheduledTask/s);
  assert.match(script, /Stop-Process/, "the old node.exe is stopped explicitly, not assumed gone");
  const scoped = restartCommand("win32", undefined, "C:\\Apps\\agent'office").args[2];
  assert.ok(scoped.includes("Contains('C:\\\\Apps\\\\agent''office\\\\packages\\\\daemon\\\\src\\\\index.js')") || scoped.includes("agent''office"), "this checkout's path, quote-escaped");
  const order = ["Stop-ScheduledTask", "Stop-Process", "Get-ScheduledTask", "Start-ScheduledTask"].map((k) => scoped.lastIndexOf(k));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "stop task → stop leftover node → wait until not Running → start");
  assert.match(commandLine(win), /^powershell -NoProfile -Command ".*"$/s, "the hint is one pasteable line");
});

test("restart failure is reported with the manual command, after the new build is already in place", async () => {
  const h = harness({ failOn: "systemctl" });
  await assert.rejects(runUpdate(h.opts), /restart/i);
  assert.ok(h.calls.some((c) => c.line.includes("run build")));
});

test("daemon not answering after restart → error pointing at the log", async () => {
  const h = harness({ healthy: false });
  await assert.rejects(runUpdate(h.opts), /not answering/i);
});

test("dry run: prints the plan, executes nothing, backs up nothing", async () => {
  const h = harness();
  const result = await runUpdate({ ...h.opts, dryRun: true });
  assert.equal(result.status, "dry-run");
  assert.deepEqual(h.calls, []);
  assert.equal(h.backups.length, 0);
  const text = h.logs.join("\n");
  assert.match(text, /git pull --ff-only/);
  assert.match(text, /npm run build/);
  assert.match(text, /systemctl --user restart/);
});

test("Windows: restart goes through the Scheduled Task", async () => {
  const h = harness({ platform: "win32" });
  await runUpdate(h.opts);
  assert.ok(h.calls.some((c) => c.line.startsWith("powershell") && c.line.includes("Start-ScheduledTask")));
});

test("swapDist: dist.next replaces dist atomically; a missing dist.next leaves dist untouched", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { swapDist } = await import("../src/cli/update.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-swap-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "old");
  assert.throws(() => swapDist(dir));
  assert.equal(fs.readFileSync(path.join(dir, "dist", "index.html"), "utf8"), "old");
  fs.mkdirSync(path.join(dir, "dist.next"));
  fs.writeFileSync(path.join(dir, "dist.next", "index.html"), "new");
  swapDist(dir);
  assert.equal(fs.readFileSync(path.join(dir, "dist", "index.html"), "utf8"), "new");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["dist"]);
});

test("only npm goes through a shell on Windows (cmd.exe would eat the | in the PowerShell restart script)", () => {
  assert.equal(needsShell("npm", "win32"), true);
  for (const cmd of ["git", "powershell", "launchctl", "systemctl"]) assert.equal(needsShell(cmd, "win32"), false, cmd);
  assert.equal(needsShell("npm", "linux"), false);
});
