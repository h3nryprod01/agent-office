// R13-INFRA: tell the onboarding wizard which agent harnesses (Claude Code,
// Codex CLI, Gemini CLI) are installed and logged in, so its "Kết nối" step can
// ask the right question per harness.
//
// Two layers, kept separate for testing:
//   - checkInstalled / classifyProbe / probeLoggedIn are pure-ish utilities
//     (spawnFn injectable) — never spawn a real CLI in tests.
//   - createHarnessHttpHandler is the HTTP route. GET /harnesses is cheap and
//     never spawns (the UI polls it); spawning only happens on the explicit
//     ?probe=<key> opt-in, and its result is cached 60s.

import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { binCandidates, commonBinDirs, cliSpawnOptions } from "./platform.js";

// The daemon runs under a service manager (launchd on macOS, a Scheduled Task on
// Windows) with a bare PATH, so a PATH-only scan reports codex/gemini/claude as
// not-installed even when they are. Probe the platform's CLI dirs too — see
// platform.js#commonBinDirs. process.execPath is the daemon's own node; nvm/
// volta install global CLIs as its siblings.
// Re-exported for any importer; platform-aware (computed once at load).
export const COMMON_BIN_DIRS = commonBinDirs();

// probeArgs: a FAST, token-free auth check per CLI. claude/codex have a
// purpose-built one; gemini has none, so it falls back to a tiny prompt. Beats
// the old `-p "ok"` full turn that was slow (hit the 8s timeout → "timed out") and
// spent a token every check.
export const HARNESSES = [
  { key: "claude", bin: "claude", label: "Claude Code", probeArgs: ["auth", "status"] },
  { key: "codex", bin: "codex", label: "Codex CLI", probeArgs: ["login", "status"] },
  { key: "gemini", bin: "gemini", label: "Gemini CLI", probeArgs: ["-p", "ok", "--output-format", "json"] },
];

// 401 / API key / authenticate / "not logged in" / a /login URL → clearly auth.
const NEEDS_LOGIN_RE = /401|invalid.?api.?key|authenticat|not logged in|\/login/i;

/**
 * Is `bin` executable on PATH or in a common bin dir? Sync + cheap — called per
 * /harnesses request. Claude also honors CHAT_CLAUDE_BIN (the chat manager's
 * stub-binary knob): if set and executable, that counts as installed.
 * @param {string} bin
 * @param {{env?: Record<string,string>, extraDirs?: string[], platform?: string}} opts
 *   extraDirs defaults to the platform's common CLI dirs (nvm/homebrew on macOS,
 *   %APPDATA%\npm etc. on Windows) so a bare service-PATH doesn't hide an
 *   installed CLI. platform/binCandidates make a Windows npm-global `claude.cmd`
 *   discoverable. Injectable for deterministic tests.
 * @returns {{installed: boolean, path: string|null}}
 */
export function checkInstalled(
  bin,
  { env = process.env, extraDirs = null, platform = process.platform } = {},
) {
  if (bin === "claude" && env.CHAT_CLAUDE_BIN) {
    try {
      accessSync(env.CHAT_CLAUDE_BIN, constants.X_OK);
      return { installed: true, path: env.CHAT_CLAUDE_BIN };
    } catch {
      // fall through to the PATH scan
    }
  }
  const dirs = [...(env.PATH ?? "").split(path.delimiter), ...(extraDirs ?? commonBinDirs(platform, env))];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of binCandidates(bin, platform)) {
      try {
        const candidate = path.join(dir, name);
        accessSync(candidate, constants.X_OK);
        return { installed: true, path: candidate };
      } catch {
        // not this name/dir — keep scanning
      }
    }
  }
  return { installed: false, path: null };
}

/**
 * Pure: turn a probe's exit code + captured output into a login verdict.
 * Separated from spawn so it tests without a process.
 */
export function classifyProbe({ code, stdout = "", stderr = "" }) {
  if (code === 0) return { loggedIn: true };
  if (NEEDS_LOGIN_RE.test(`${stderr}\n${stdout}`)) {
    return { loggedIn: false, reason: "sign-in required" };
  }
  return { loggedIn: false, reason: "unknown error" };
}

/**
 * Spawn `bin -p "ok" --output-format json` once and classify the result.
 * `spawnFn` is injectable so tests never run a real CLI. A hang past timeoutMs
 * kills the child and reports "timed out" rather than waiting forever.
 * @returns {Promise<{loggedIn:boolean, reason?:string}>}
 */
export function probeLoggedIn({
  bin,
  args = ["-p", "ok", "--output-format", "json"],
  timeoutMs = 8000,
  spawnFn = spawn,
  platform = process.platform,
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawnFn(bin, args, cliSpawnOptions(platform));
    } catch {
      return done({ loggedIn: false, reason: "unknown error" });
    }
    timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // already dead — nothing to kill
      }
      done({ loggedIn: false, reason: "timed out" });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", () => done({ loggedIn: false, reason: "unknown error" }));
    child.on("close", (code) => done(classifyProbe({ code, stdout, stderr })));
  });
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const CACHE_TTL_MS = 60_000;

/**
 * GET /harnesses → [{key,label,installed,loggedIn,reason}]. installed is fresh
 *   per call (cheap PATH check); loggedIn is the cached probe result if still
 *   valid, else null (not yet probed). NEVER spawns here.
 * GET /harnesses?probe=<key> → runs probeLoggedIn for that harness (if
 *   installed), caches it, returns the full list. Unknown key → 400.
 *
 * @param {{probeFn?: Function, checkInstalledFn?: Function}} opts
 *   probeFn / checkInstalledFn default to the real implementations; tests
 *   inject fakes so no real CLI runs and installed-status is deterministic.
 */
export function createHarnessHttpHandler({
  probeFn = probeLoggedIn,
  checkInstalledFn = checkInstalled,
} = {}) {
  /** @type {Map<string, {loggedIn:boolean, reason?:string, at:number}>} */
  const cache = new Map();

  const buildList = () =>
    HARNESSES.map((h) => {
      const { installed } = checkInstalledFn(h.bin);
      const entry = cache.get(h.key);
      let loggedIn = null;
      let reason = null;
      if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
        loggedIn = entry.loggedIn;
        reason = entry.reason ?? null;
      }
      return { key: h.key, label: h.label, installed, loggedIn, reason };
    });

  const respond = (res, status, payload) => {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  return (req, res, url) => {
    if (url.pathname !== "/harnesses") return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }
    if (req.method !== "GET") {
      respond(res, 405, { error: "method not allowed" });
      return true;
    }

    const probeKey = url.searchParams.get("probe");
    if (probeKey === null) {
      respond(res, 200, buildList());
      return true;
    }

    const harness = HARNESSES.find((h) => h.key === probeKey);
    if (!harness) {
      respond(res, 400, { error: "unknown harness" });
      return true;
    }
    const { installed, path } = checkInstalledFn(harness.bin);
    if (!installed) {
      // nothing to probe — leave loggedIn null, return the list as-is
      respond(res, 200, buildList());
      return true;
    }
    // probe (async) → cache → respond. Spawn the RESOLVED path, not the bare
    // name: the launchd daemon's PATH is sparse, so `claude`/`codex`/`gemini`
    // won't resolve by name even though checkInstalled found them → "unknown error".
    probeFn({ bin: path ?? harness.bin, args: harness.probeArgs }).then((result) => {
      cache.set(harness.key, { ...result, at: Date.now() });
      respond(res, 200, buildList());
    });
    return true;
  };
}
