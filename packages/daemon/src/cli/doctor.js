// lane L1: `doctor` — is this machine ready to run Agent Office, and if not, what
// exactly do I type to fix it? Each check returns {id, status, title, detail?, fix?}.
//   status: ok | warn | fail | info      blocking: a failure that stops the office itself
// Everything environmental is injectable, so tests exercise the Windows and
// failure paths on any OS. It is read-only: nothing on the machine is created or changed.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkInstalled } from "../harness-probe.js";
import { AccessStore, agentOfficeHome } from "../access.js";

const MIN_NODE_MAJOR = 20;
const MIN_RAM_GB = 4;
const SERVICE_NAME = { darwin: "com.agentoffice.daemon", linux: "agent-office-daemon", win32: "AgentOfficeDaemon" };

const HARNESS_HINTS = {
  claude: {
    label: "Claude Code",
    fix: "npm install -g @anthropic-ai/claude-code   then run `claude` once and sign in",
  },
  codex: { label: "Codex CLI", fix: "npm install -g @openai/codex   then run `codex login`" },
  gemini: { label: "Gemini CLI", fix: "npm install -g @google/gemini-cli   then run `gemini` once and sign in" },
};

function nodeFix(platform) {
  if (platform === "win32") return "winget install OpenJS.NodeJS.LTS   (or download the LTS installer from https://nodejs.org)";
  if (platform === "darwin") return "brew install node@22   (or download the LTS installer from https://nodejs.org)";
  return "install Node.js 20 or newer from https://nodejs.org/en/download (or with nvm: nvm install --lts)";
}

function gb(bytes) {
  return (bytes / 2 ** 30).toFixed(1);
}

/** "free" | "ao" (our own daemon already there) | "busy" (someone else). */
export async function probePort(port) {
  const free = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
  if (free) return "free";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/transcript?limit=1`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return Array.isArray(body) ? "ao" : "busy";
  } catch {
    return "busy";
  }
}

function defaultExec(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  return { status: res.status ?? 1, stdout: res.stdout ?? "" };
}

function serviceInstalled({ platform, exec }) {
  const name = SERVICE_NAME[platform];
  if (!name) return null;
  if (platform === "darwin") return exec("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${name}`]).status === 0;
  if (platform === "linux") return exec("systemctl", ["--user", "is-enabled", `${name}.service`]).status === 0;
  return exec("schtasks", ["/Query", "/TN", name]).status === 0;
}

/**
 * @param {object} [o] every field is injectable for tests
 * @returns {Promise<{id: string, status: string, title: string, detail?: string, fix?: string, blocking?: boolean}[]>}
 */
export async function runChecks({
  platform = process.platform,
  nodeVersion = process.version,
  env = process.env,
  home = agentOfficeHome(env),
  repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."),
  port = Number(env.DAEMON_WS_PORT ?? 8787),
  totalmem = os.totalmem(),
  which = (bin) => checkInstalled(bin, { env, platform }),
  probePort: probe = probePort,
  exec = defaultExec,
  preflight = false,
} = {}) {
  const out = [];
  const add = (r) => out.push(r);

  // --- runtime
  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0);
  add(
    major >= MIN_NODE_MAJOR
      ? { id: "node", status: "ok", title: `Node.js ${nodeVersion.replace(/^v/, "")}` }
      : {
          id: "node",
          status: "fail",
          blocking: true,
          title: `Node.js ${MIN_NODE_MAJOR}+ is required`,
          detail: `found ${nodeVersion.replace(/^v/, "")}`,
          fix: nodeFix(platform),
        },
  );

  const npm = which("npm");
  add(
    npm.installed
      ? { id: "npm", status: "ok", title: "npm" }
      : { id: "npm", status: "fail", blocking: true, title: "npm not found", fix: `npm ships with Node.js — ${nodeFix(platform)}` },
  );
  const git = which("git");
  add(
    git.installed
      ? { id: "git", status: "ok", title: "git" }
      : {
          id: "git",
          status: "warn",
          title: "git not found (needed only for `update`)",
          fix: platform === "win32" ? "winget install Git.Git" : platform === "darwin" ? "xcode-select --install" : "sudo apt install -y git",
        },
  );

  // --- the agents Agent Office watches
  for (const bin of ["claude", "codex", "gemini"]) {
    const hint = HARNESS_HINTS[bin];
    const found = which(bin);
    if (found.installed) {
      add({ id: bin, status: "ok", title: `${hint.label} (${found.path})` });
    } else if (bin === "claude") {
      add({ id: bin, status: "fail", title: `${hint.label} not found on PATH`, detail: "the PM chat and approvals need it", fix: hint.fix });
    } else {
      add({ id: bin, status: "info", title: `${hint.label} not installed (optional)`, fix: hint.fix });
    }
  }

  // --- port
  const portState = await probe(port);
  if (portState === "free") add({ id: "port", status: "ok", title: `port ${port} is free` });
  else if (portState === "ao") add({ id: "port", status: "ok", title: `port ${port}: Agent Office is already running` });
  else {
    const who = platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`;
    add({
      id: "port",
      status: "fail",
      blocking: true,
      title: `port ${port} is used by another program`,
      fix: `find it with: ${who}   — stop it, or run Agent Office on another port: DAEMON_WS_PORT=${port + 1}`,
    });
  }

  // --- storage
  try {
    // Read-only check: walk up to the nearest directory that exists and ask for write
    // access, so doctor never creates or touches the user's data directory.
    // (Windows reports only the read-only attribute here, not ACLs.)
    let target = home;
    while (!fs.existsSync(target)) target = path.dirname(target);
    if (!fs.statSync(target).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    fs.accessSync(target, fs.constants.W_OK);
    add({ id: "home", status: "ok", title: `${home} is writable` });
  } catch (error) {
    add({
      id: "home",
      status: "fail",
      blocking: true,
      title: `cannot write to ${home}`,
      detail: error.code ?? error.message,
      fix:
        platform === "win32"
          ? `check that your user owns ${home} (Properties > Security) or set AGENT_OFFICE_HOME to a folder you own`
          : `chmod -R u+rwX ${home}   (or set AGENT_OFFICE_HOME to a folder you own)`,
    });
  }

  if (!preflight) {
    const wsInstalled = fs.existsSync(path.join(repo, "packages", "daemon", "node_modules", "ws"));
    add(
      wsInstalled
        ? { id: "deps", status: "ok", title: "daemon dependencies installed" }
        : { id: "deps", status: "warn", title: "daemon dependencies are not installed", fix: "run the start script (it installs them): ./scripts/start.sh  |  scripts\\start.ps1" },
    );
    const built = fs.existsSync(path.join(repo, "packages", "renderer", "dist", "index.html"));
    add(
      built
        ? { id: "build", status: "ok", title: "renderer is built" }
        : { id: "build", status: "warn", title: "renderer is not built — the daemon would serve a blank page", fix: "run the start script (it builds): ./scripts/start.sh  |  scripts\\start.ps1" },
    );
  }

  add(
    totalmem >= MIN_RAM_GB * 2 ** 30
      ? { id: "memory", status: "ok", title: `${gb(totalmem)} GB RAM` }
      : { id: "memory", status: "warn", title: "low memory", detail: `${gb(totalmem)} GB RAM; ${MIN_RAM_GB} GB is the practical minimum with one or two agents running`, fix: "close other apps, or use a machine with 8 GB+" },
  );

  // --- optional voice
  const ttsPython =
    env.VIENEU_PYTHON ??
    path.join(repo, ".venv-tts", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
  add(
    fs.existsSync(ttsPython)
      ? { id: "voice", status: "ok", title: "voice (TTS) environment found" }
      : { id: "voice", status: "info", title: "voice (TTS) not set up (optional — the browser voice is used instead)", fix: "see packages/daemon/src/tts.js for the python venv, then set VIENEU_PYTHON" },
  );

  // --- LAN access
  const store = new AccessStore({ file: path.join(home, "access.json") });
  const accessFile = path.join(home, "access.json");
  if (fs.existsSync(accessFile) && platform !== "win32") {
    const mode = fs.statSync(accessFile).mode & 0o777;
    add(
      mode & 0o077
        ? { id: "access", status: "warn", title: "access.json is readable by other users", detail: `mode is ${mode.toString(8)}`, fix: `chmod 600 ${accessFile}` }
        : { id: "access", status: "ok", title: "access.json is private (600)" },
    );
  }
  const lanHost = env.DAEMON_WS_HOST && !["127.0.0.1", "localhost", "::1"].includes(env.DAEMON_WS_HOST);
  if (store.lanEnabled() || lanHost) {
    const tokens = store.list().length;
    add(
      tokens === 0
        ? { id: "lan", status: "warn", title: "LAN access is on", detail: "no tokens exist, so every remote request is refused", fix: "node scripts/ao.mjs token add --label me --role owner" }
        : { id: "lan", status: "ok", title: `LAN access is on, ${tokens} token(s) issued` },
    );
  } else {
    add({ id: "lan", status: "info", title: "LAN access is off (this machine only)", fix: "to let others in: node scripts/ao.mjs lan on" });
  }

  // --- service
  const installed = serviceInstalled({ platform, exec });
  if (installed === true) add({ id: "service", status: "ok", title: "background service installed" });
  else if (installed === false) {
    add({
      id: "service",
      status: "info",
      title: "background service not installed (the office stops when you log out)",
      fix: platform === "win32" ? "scripts\\start.ps1" : platform === "linux" ? "./scripts/install-ubuntu.sh" : "./scripts/start.sh",
    });
  }
  return out;
}

const TAG = { ok: "[ok]   ", warn: "[warn] ", fail: "[FAIL] ", info: "[info] " };

export function formatReport(results, { onlyProblems = false } = {}) {
  const lines = [];
  for (const r of results) {
    if (onlyProblems && (r.status === "ok" || r.status === "info")) continue;
    lines.push(`${TAG[r.status]}${r.title}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.fix && r.status !== "ok") lines.push(`        fix: ${r.fix}`);
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("");
  lines.push(
    fails + warns === 0
      ? "Everything looks good."
      : `${fails} problem${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}.`,
  );
  return lines.join("\n");
}

/** 1 when something is broken. In preflight only failures that stop the office itself count. */
export function exitCode(results, { preflight = false } = {}) {
  return results.some((r) => r.status === "fail" && (!preflight || r.blocking)) ? 1 : 0;
}
