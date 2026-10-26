// lane L1: `doctor` must say what is wrong AND how to fix it, per platform. Every
// environment fact is injected, so the Windows and failure paths run on any OS.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks, formatReport, exitCode } from "../src/cli/doctor.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ao-doctor-"));
}

// only the named binaries exist (npm/git stay installed unless excluded)
const only = (...present) => (bin) =>
  present.includes(bin) || bin === "npm" || bin === "git" ? { installed: true, path: `/x/${bin}` } : { installed: false, path: null };

function env(over = {}) {
  const repo = tmp();
  fs.mkdirSync(path.join(repo, "packages", "daemon", "node_modules", "ws"), { recursive: true });
  fs.mkdirSync(path.join(repo, "packages", "renderer", "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages", "renderer", "dist", "index.html"), "<html>");
  return {
    platform: "linux",
    nodeVersion: "v22.1.0",
    env: {},
    home: path.join(tmp(), ".agent-office"),
    repo,
    port: 8787,
    totalmem: 16 * 2 ** 30,
    which: (bin) => ({ installed: true, path: `/usr/bin/${bin}` }),
    probePort: async () => "free",
    exec: () => ({ status: 0, stdout: "" }),
    ...over,
  };
}

const byId = (results, id) => results.find((r) => r.id === id);

test("a healthy machine: no failures, exit 0", async () => {
  const results = await runChecks(env());
  assert.deepEqual(results.filter((r) => r.status === "fail"), []);
  assert.equal(exitCode(results), 0);
  assert.equal(byId(results, "node").status, "ok");
  assert.equal(byId(results, "port").status, "ok");
});

test("node too old → blocking fail with a platform-specific fix", async () => {
  for (const [platform, hint] of [["win32", /winget/], ["darwin", /brew install node/], ["linux", /nodejs\.org/]]) {
    const r = byId(await runChecks(env({ platform, nodeVersion: "v18.19.0" })), "node");
    assert.equal(r.status, "fail");
    assert.equal(r.blocking, true);
    assert.match(r.fix, hint, platform);
    assert.match(r.detail, /18\.19\.0/);
  }
  assert.equal(byId(await runChecks(env({ nodeVersion: "v20.0.0" })), "node").status, "ok");
});

test("claude missing is a failure with the install command; codex/gemini missing are only info", async () => {
  const results = await runChecks(env({ which: only() }));
  const claude = byId(results, "claude");
  assert.equal(claude.status, "fail");
  assert.equal(claude.blocking, undefined, "not blocking: the office still starts");
  assert.match(claude.fix, /npm install -g @anthropic-ai\/claude-code/);
  assert.equal(byId(results, "codex").status, "info");
  assert.equal(byId(results, "gemini").status, "info");
  assert.match(byId(results, "codex").fix, /@openai\/codex/);
});

test("claude installed, others missing → still no failure", async () => {
  assert.equal(exitCode(await runChecks(env({ which: only("claude") }))), 0);
});

test("port: free ok / our own daemon ok / something else → blocking fail with lsof or netstat", async () => {
  assert.equal(byId(await runChecks(env({ probePort: async () => "ao" })), "port").status, "ok");
  const busy = byId(await runChecks(env({ probePort: async () => "busy", port: 8791 })), "port");
  assert.equal(busy.status, "fail");
  assert.equal(busy.blocking, true);
  assert.match(busy.fix, /lsof -i :8791/);
  assert.match(busy.fix, /DAEMON_WS_PORT/);
  const win = byId(await runChecks(env({ probePort: async () => "busy", platform: "win32" })), "port");
  assert.match(win.fix, /netstat -ano/);
});

test("home: missing-but-creatable or writable → ok, and doctor itself creates nothing; blocked → fail", async () => {
  const e = env();
  assert.equal(byId(await runChecks(e), "home").status, "ok");
  assert.ok(!fs.existsSync(e.home), "doctor is read-only");
  fs.mkdirSync(e.home);
  assert.equal(byId(await runChecks(e), "home").status, "ok");
  assert.deepEqual(fs.readdirSync(e.home), [], "no probe file either");

  const blocked = path.join(tmp(), "file-not-dir");
  fs.writeFileSync(blocked, "x");
  const r = byId(await runChecks(env({ home: path.join(blocked, ".agent-office") })), "home");
  assert.equal(r.status, "fail");
  assert.equal(r.blocking, true);
  assert.ok(r.fix);
});

test("deps and build: missing → warn with the one command that fixes both", async () => {
  const e = env({ repo: tmp() });
  const results = await runChecks(e);
  assert.equal(byId(results, "deps").status, "warn");
  assert.equal(byId(results, "build").status, "warn");
  assert.match(byId(results, "build").fix, /start/);
  const pre = await runChecks({ ...e, preflight: true });
  assert.equal(byId(pre, "deps"), undefined, "preflight runs before install, so these would only nag");
  assert.equal(byId(pre, "build"), undefined);
});

test("low memory warns, never fails", async () => {
  const r = byId(await runChecks(env({ totalmem: 3 * 2 ** 30 })), "memory");
  assert.equal(r.status, "warn");
  assert.match(r.detail, /3\.0 GB/);
});

test("access.json: world-readable → warn with chmod; LAN on with no tokens → warn", async () => {
  const e = env();
  fs.mkdirSync(e.home, { recursive: true });
  const file = path.join(e.home, "access.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, lan: true, tokens: [] }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const results = await runChecks(e);
  const access = byId(results, "access");
  assert.equal(access.status, "warn");
  if (process.platform !== "win32") assert.match(access.detail + (access.fix ?? ""), /chmod 600/);
  assert.match(byId(results, "lan").detail, /no tokens/i);
  assert.equal(byId(results, "lan").status, "warn");
});

test("LAN host set by environment without any token is flagged even if access.json is absent", async () => {
  const r = byId(await runChecks(env({ env: { DAEMON_WS_HOST: "0.0.0.0" } })), "lan");
  assert.equal(r.status, "warn");
});

test("service: not installed → info with the command that installs it", async () => {
  const results = await runChecks(env({ exec: () => ({ status: 1, stdout: "" }) }));
  const svc = byId(results, "service");
  assert.equal(svc.status, "info");
  assert.match(svc.fix, /start\.sh|install-ubuntu|start\.ps1/);
});

test("formatReport: every problem is followed by its fix; preflight prints only what is not ok", async () => {
  const results = await runChecks(env({ nodeVersion: "v18.0.0", which: only() }));
  const text = formatReport(results);
  assert.match(text, /\[FAIL\].*Node/);
  assert.match(text, /fix: .*nodejs\.org/);
  assert.match(text, /problem/);
  const quiet = formatReport(await runChecks(env()), { onlyProblems: true });
  assert.ok(!/\[ok\]/.test(quiet));
  assert.equal(exitCode(results), 1);
});

test("exitCode in preflight mode only counts blocking failures", async () => {
  const results = await runChecks(env({ which: only() }));
  assert.equal(exitCode(results), 1);
  assert.equal(exitCode(results, { preflight: true }), 0);
});
