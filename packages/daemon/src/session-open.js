// "Open this agent's session": POST /sessions/open-terminal {agentId} opens a
// terminal window at the working directory of that agent.
//
// The folder is NEVER taken from the request. The daemon looks the agent up in
// what it observed itself (radar.agentCwd) — so a stray page can at worst open
// a terminal in a folder where an agent is already running. (Cross-origin
// callers are also refused earlier by the origin guard.) /open from outputs.js
// does not fit: it is a whitelist of media files, and a session's cwd is not one.
//
// The resume COMMANDS (`claude --resume <id>`, `codex resume <id>`) are plain
// text built in the renderer (ui/sessionActions.ts) — copying needs no daemon.

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isLinux, isWindows } from "./platform.js";


/**
 * @param {string} cwd already realpath-resolved directory
 * @param {string} [platform]
 * @param {Record<string, string|undefined>} [env]
 * @returns {{cmd: string, args: string[], options: {cwd?: string}}}
 */
export function terminalCommand(cwd, platform = process.platform, env = process.env) {
  if (isWindows(platform)) {
    // Absolute shell path, and NO cwd option on the launch: Windows looks in the working
    // folder before PATH, so a program an agent planted there as cmd.exe would run.
    const shell = env.ComSpec || path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return { cmd: shell, args: ["/c", "start", "/D", cwd, shell], options: {} };
  }
  // ponytail: x-terminal-emulator is the Debian alternative; other distros may lack it
  if (isLinux(platform)) return { cmd: "x-terminal-emulator", args: [], options: { cwd } };
  return { cmd: "open", args: ["-a", "Terminal", cwd], options: {} };
}

/**
 * @param {Object} opts
 * @param {(agentId: string) => string|null} opts.resolveCwd
 * @param {typeof execFile} [opts.execFileFn]
 * @param {string} [opts.platform]
 */
export function createSessionOpenHandler({ resolveCwd, execFileFn = execFile, platform = process.platform }) {
  return (req, res, url) => {
    if (url.pathname !== "/sessions/open-terminal") return false;
    const respond = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== "POST") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const agentId = parsed?.agentId;
      if (typeof agentId !== "string" || !agentId) {
        respond(400, { error: "agentId required" });
        return;
      }
      const cwd = resolveCwd(agentId);
      let real;
      try {
        if (!cwd) throw new Error("unknown agent");
        real = realpathSync(cwd);
        if (!statSync(real).isDirectory()) throw new Error("not a directory");
      } catch {
        respond(404, { error: "no known working directory for that agent" });
        return;
      }
      const { cmd, args, options } = terminalCommand(real, platform);
      execFileFn(cmd, args, options, (error) => {
        // `cmd /c start` detaches and may report a non-zero code even on success (same quirk as explorer in outputs.js)
        if (error && !isWindows(platform)) {
          console.error("[session-open] launch failed:", error.message);
          respond(500, { error: "could not open a terminal" });
          return;
        }
        respond(200, { ok: true });
      });
    });
    return true;
  };
}
