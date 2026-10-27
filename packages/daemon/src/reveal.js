// Show a folder or a file in the host's file manager (Finder / Explorer / the Linux default).
//
//   POST /reveal {agentId}               → open the folder that agent works in
//   POST /reveal {agentId, lastFile:true} → select the last file that agent wrote
//   POST /reveal {project}               → open the project's folder
//
// The path is NEVER taken from the request: it comes from what the daemon saw itself (the
// radar's per-agent cwd and last written file) or from the project's own project.json. A
// folder is opened; a file is only REVEALED (selected in its folder) — opening a file would
// launch whatever the OS associates with it, which for a script means running it.
// Owner-only and refused while presenting (access.js / presentation install.ts): it acts on
// the host's desktop.

import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";

import { revealCommand, isWindows } from "./platform.js";
import { readProject, DEFAULT_PROJECTS_DIR } from "./projects.js";

const BODY_MAX = 4096;

/**
 * @param {Object} opts
 * @param {(agentId: string) => string|null} opts.agentCwd
 * @param {(agentId: string) => string|null} opts.agentLastFile
 * @param {string} [opts.projectsDir]
 * @param {typeof execFile} [opts.execFileFn]
 * @param {string} [opts.platform]
 */
export function createRevealHandler({ agentCwd, agentLastFile, projectsDir = DEFAULT_PROJECTS_DIR, execFileFn = execFile, platform = process.platform }) {
  return (req, res, url) => {
    if (url.pathname !== "/reveal") return false;
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
      if (body.length > BODY_MAX) req.destroy();
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // falls through to the 400 below
      }
      const target = resolveTarget(parsed, { agentCwd, agentLastFile, projectsDir });
      if (target.error) {
        respond(target.status, { error: target.error });
        return;
      }
      const { cmd, args } = revealCommand(target.path, target.reveal, platform);
      execFileFn(cmd, args, {}, (error) => {
        // explorer.exe exits 1 even on success (same quirk as outputs.js)
        if (error && !isWindows(platform)) {
          console.error("[reveal] launch failed:", error.message);
          respond(500, { error: "could not open the file manager" });
          return;
        }
        respond(200, { ok: true, kind: target.reveal ? "file" : "folder" });
      });
    });
    return true;
  };
}

/** @returns {{path: string, reveal: boolean} | {status: number, error: string}} */
export function resolveTarget(body, { agentCwd, agentLastFile, projectsDir }) {
  const agentId = typeof body?.agentId === "string" && body.agentId ? body.agentId : null;
  const project = typeof body?.project === "string" && body.project ? body.project : null;
  if (!agentId && !project) return { status: 400, error: "agentId or project required" };

  if (agentId && body.lastFile === true) {
    const file = existing(agentLastFile(agentId), "file");
    return file ? { path: file, reveal: true } : { status: 404, error: "that agent has not written a file the office saw" };
  }
  let dir = null;
  if (agentId) dir = agentCwd(agentId);
  else {
    try {
      dir = readProject({ projectsDir, slug: project }).cwd ?? null;
    } catch {
      return { status: 404, error: "no such project" };
    }
  }
  const real = existing(dir, "dir");
  return real ? { path: real, reveal: false } : { status: 404, error: "no known folder for that" };
}

function existing(p, kind) {
  if (typeof p !== "string" || !p) return null;
  try {
    const real = realpathSync(p);
    const st = statSync(real);
    if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}
