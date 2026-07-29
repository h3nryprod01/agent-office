import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import {
  HARNESSES,
  checkInstalled,
  classifyProbe,
  probeLoggedIn,
  createHarnessHttpHandler,
} from "../src/harness-probe.js";

test("classifyProbe: code 0 → logged in; 401 → needs login; other → unknown", () => {
  assert.deepEqual(classifyProbe({ code: 0 }), { loggedIn: true });
  assert.deepEqual(classifyProbe({ code: 1, stderr: "Error: 401 unauthorized" }), {
    loggedIn: false,
    reason: "cần đăng nhập",
  });
  assert.deepEqual(classifyProbe({ code: 1, stdout: "invalid api key" }), {
    loggedIn: false,
    reason: "cần đăng nhập",
  });
  assert.deepEqual(classifyProbe({ code: 1, stderr: "some random junk" }), {
    loggedIn: false,
    reason: "lỗi không rõ",
  });
});

test("checkInstalled: fake PATH with an executable → installed; empty PATH → not", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-probe-path-"));
  const binPath = path.join(dir, "claude");
  writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
  chmodSync(binPath, 0o755);

  // extraDirs: [] isolates the PATH scan from the machine's real nvm/homebrew
  // dirs (COMMON_BIN_DIRS), where codex/claude actually live — otherwise these
  // assertions would find the real binaries and stop being deterministic.
  const found = checkInstalled("claude", { env: { PATH: dir }, extraDirs: [] });
  assert.equal(found.installed, true);
  assert.equal(found.path, binPath);

  // a different binary not present in that dir
  assert.equal(checkInstalled("codex", { env: { PATH: dir }, extraDirs: [] }).installed, false);

  // empty PATH → nothing found
  assert.deepEqual(checkInstalled("claude", { env: { PATH: "" }, extraDirs: [] }), { installed: false, path: null });

  rmSync(dir, { recursive: true, force: true });
});

test("checkInstalled: a binary in extraDirs (not on PATH) is still found — the launchd-PATH fix", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-probe-extra-"));
  const binPath = path.join(dir, "codex");
  writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
  chmodSync(binPath, 0o755);

  // launchd gives the daemon a bare PATH that omits nvm/homebrew; codex lives in
  // one of those dirs (here: extraDirs). PATH-only would miss it → installed:false.
  assert.equal(checkInstalled("codex", { env: { PATH: "" }, extraDirs: [] }).installed, false);
  const found = checkInstalled("codex", { env: { PATH: "/nonexistent" }, extraDirs: [dir] });
  assert.equal(found.installed, true);
  assert.equal(found.path, binPath);

  rmSync(dir, { recursive: true, force: true });
});

test("probeLoggedIn: spawnFn exit 0 → logged in; hang → timeout 'quá hạn'", async () => {
  const spawnOk = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  const ok = await probeLoggedIn({ bin: "claude", spawnFn: spawnOk });
  assert.deepEqual(ok, { loggedIn: true });

  const spawnHang = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {}; // never emits close
    return child;
  };
  const hung = await probeLoggedIn({ bin: "claude", spawnFn: spawnHang, timeoutMs: 30 });
  assert.equal(hung.loggedIn, false);
  assert.equal(hung.reason, "quá hạn");
});

/**
 * Drive the HTTP handler like ws-server's extraHttp. res.end resolves the
 * promise (handler responds synchronously for /harnesses, async for ?probe=).
 */
function call(handler, { method = "GET", search = "" } = {}) {
  return new Promise((resolve) => {
    const req = { method };
    const res = {
      status: null,
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = { ...this.headers, ...headers };
      },
      end(body) {
        let parsed;
        if (body != null && body !== "") {
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = String(body);
          }
        }
        resolve({ handled: true, status: this.status, headers: this.headers, body: parsed });
      },
    };
    const handled = handler(req, res, new URL(`http://x/harnesses${search}`));
    if (!handled) resolve({ handled: false });
  });
}

test("GET /harnesses never probes; loggedIn null until probed", async () => {
  let probeCalls = 0;
  const probeFn = async () => {
    probeCalls++;
    return { loggedIn: true };
  };
  const checkInstalledFn = (bin) => ({
    installed: bin === "claude",
    path: bin === "claude" ? "/fake/claude" : null,
  });
  const handler = createHarnessHttpHandler({ probeFn, checkInstalledFn });

  const r = await call(handler);
  assert.equal(r.status, 200);
  assert.equal(probeCalls, 0); // GET /harnesses must not spawn
  assert.equal(r.body.length, HARNESSES.length);
  const claude = r.body.find((h) => h.key === "claude");
  assert.equal(claude.installed, true);
  assert.equal(claude.loggedIn, null); // never probed → null
});

test("?probe=claude probes once; subsequent GET /harnesses serves cache", async () => {
  let probeCalls = 0;
  let probedBin = null;
  let probedArgs = null;
  const probeFn = async ({ bin, args }) => {
    probeCalls++;
    probedBin = bin;
    probedArgs = args;
    return { loggedIn: true };
  };
  const checkInstalledFn = (bin) => ({
    installed: bin === "claude",
    path: bin === "claude" ? "/fake/claude" : null,
  });
  const handler = createHarnessHttpHandler({ probeFn, checkInstalledFn });

  const probed = await call(handler, { search: "?probe=claude" });
  assert.equal(probed.status, 200);
  assert.equal(probeCalls, 1);
  assert.equal(probedBin, "/fake/claude"); // spawns the RESOLVED path, not the bare "claude"
  assert.deepEqual(probedArgs, ["auth", "status"]); // fast token-free auth check for claude
  assert.equal(probed.body.find((h) => h.key === "claude").loggedIn, true);

  const cached = await call(handler);
  assert.equal(probeCalls, 1); // cache hit — no second probe
  assert.equal(cached.body.find((h) => h.key === "claude").loggedIn, true);
});

test("?probe=<unknown> → 400", async () => {
  const handler = createHarnessHttpHandler({
    probeFn: async () => ({ loggedIn: true }),
    checkInstalledFn: () => ({ installed: false, path: null }),
  });
  const r = await call(handler, { search: "?probe=khong-co" });
  assert.equal(r.status, 400);
});

test("checkInstalled: win32 finds claude.cmd in %APPDATA%\\npm (npm-global shim) — no real Windows needed", () => {
  // On Windows, `npm i -g @anthropic/claude` installs a `claude.cmd` shim under
  // %APPDATA%\npm. A bare-name PATH scan misses it; binCandidates tries .cmd.
  const base = mkdtempSync(path.join(os.tmpdir(), "harness-win-appdata-"));
  const npmDir = path.join(base, "npm"); // path.join(APPDATA, "npm") must resolve here
  mkdirSync(npmDir);
  const cmdPath = path.join(npmDir, "claude.cmd");
  writeFileSync(cmdPath, "@echo off\r\nexit 0\r\n");
  chmodSync(cmdPath, 0o755); // accessSync X_OK needs the exec bit on macOS

  const found = checkInstalled("claude", {
    platform: "win32",
    env: { PATH: "", APPDATA: base, USERPROFILE: base },
    // isolate from the real machine's node dir (it may hold a bare `claude` that
    // would shadow claude.cmd); npmDir stands in for %APPDATA%\npm.
    extraDirs: [npmDir],
  });
  assert.equal(found.installed, true);
  assert.equal(found.path, cmdPath);

  // sanity: the .cmd shim is what matched, and darwin (bare-name only) misses it
  assert.equal(
    checkInstalled("claude", { platform: "darwin", env: { PATH: npmDir }, extraDirs: [] }).installed,
    false,
  );

  rmSync(base, { recursive: true, force: true });
});
