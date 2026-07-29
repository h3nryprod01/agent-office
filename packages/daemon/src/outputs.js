// "Tủ hồ sơ" (wi-office-life): browse + open real project outputs from the
// office UI. GET /outputs lists files under a small whitelist of roots;
// POST /open shells out to the platform file manager (`open`/`explorer`) for
// exactly one of those files.
//
// The daemon only binds 127.0.0.1, but that alone doesn't make POST /open
// safe — any page open in the user's browser can still fetch() a localhost
// port. The whitelist + realpath containment check below is the actual
// security boundary, not the bind address.

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { revealCommand } from "./platform.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const KIND_BY_EXT = {
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".pdf": "doc",
  ".md": "doc",
  ".txt": "doc",
  ".srt": "doc",
};

function kindOf(filePath) {
  return KIND_BY_EXT[path.extname(filePath).toLowerCase()] ?? "other";
}

export class OutputsIndex {
  /**
   * @param {Object} opts
   * @param {string} opts.repoRoot        this repo's root — docs/media/** is the primary whitelist root
   * @param {string} [opts.workItemsPath] work-items.json; any `pr`/`obsidianNote` field that is
   *   itself an existing absolute local path becomes an extra single-file whitelist root
   */
  constructor({ repoRoot, workItemsPath }) {
    this.mediaRoot = path.join(repoRoot, "docs", "media");
    this.workItemsPath = workItemsPath;
  }

  /**
   * Whitelist roots, realpath'd — recomputed on every call (cheap: a stat of
   * a handful of paths) so a newly-landed work item's local path is pickup
   * without a daemon restart, and a symlinked root can't be swapped later.
   * @returns {string[]}
   */
  whitelistRoots() {
    const roots = [];
    if (existsSync(this.mediaRoot)) roots.push(realpathSync(this.mediaRoot));
    for (const p of this.#localWorkItemPaths()) {
      try {
        roots.push(realpathSync(p));
      } catch {
        /* listed but gone since — skip, not fatal */
      }
    }
    return roots;
  }

  #localWorkItemPaths() {
    if (!this.workItemsPath || !existsSync(this.workItemsPath)) return [];
    let items;
    try {
      items = JSON.parse(readFileSync(this.workItemsPath, "utf8")).items ?? [];
    } catch {
      return [];
    }
    const paths = [];
    for (const item of items) {
      for (const value of [item.pr, item.obsidianNote]) {
        if (typeof value === "string" && path.isAbsolute(value) && existsSync(value)) {
          paths.push(value);
        }
      }
    }
    return paths;
  }

  /** Every file reachable under the whitelist, newest first. Directory roots recurse; a file root is itself the one entry. */
  async list() {
    const out = [];
    for (const root of this.whitelistRoots()) {
      const rootStat = await stat(root).catch(() => null);
      if (!rootStat) continue;
      if (rootStat.isFile()) {
        out.push(toEntry(root, rootStat));
        continue;
      }
      let entries;
      try {
        entries = await readdir(root, { recursive: true, withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue; // .DS_Store etc — not a real output
        const filePath = path.join(entry.parentPath ?? entry.path, entry.name);
        const fileStat = await stat(filePath).catch(() => null);
        if (fileStat) out.push(toEntry(filePath, fileStat));
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /** True if `realTarget` (already realpath-resolved) is inside — or is exactly — one of the whitelist roots. */
  isAllowed(realTarget) {
    return this.whitelistRoots().some(
      (root) => realTarget === root || realTarget.startsWith(root + path.sep),
    );
  }
}

function toEntry(filePath, st) {
  return { name: path.basename(filePath), path: filePath, size: st.size, mtime: st.mtimeMs, kind: kindOf(filePath) };
}

/**
 * GET /outputs → {files: [...]}; POST /open {path, reveal?} → shell out to
 * `open`/`open -R`. Same extraHttp contract as the other daemon routes
 * (returns true once the request is handled).
 * @param {OutputsIndex} index
 * @param {Object} [opts]
 * @param {typeof execFile} [opts.execFileFn] injectable for tests (chat-session.js's spawnFn pattern)
 * @param {string} [opts.platform] defaults to the real platform
 */
export function createOutputsHttpHandler(index, { execFileFn = execFile, platform = process.platform } = {}) {
  return (req, res, url) => {
    if (url.pathname !== "/outputs" && url.pathname !== "/open") return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    const respond = (statusCode, payload) => {
      res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === "/outputs") {
      if (req.method !== "GET") {
        respond(405, { error: "method not allowed" });
        return true;
      }
      index
        .list()
        .then((files) => respond(200, { files }))
        .catch((error) => {
          console.error("[outputs] list failed:", error);
          respond(500, { error: "outputs scan failed" });
        });
      return true;
    }

    // /open
    if (req.method !== "POST") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy(); // a path never needs to be this long
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const requestedPath = parsed?.path;
      if (typeof requestedPath !== "string" || !requestedPath) {
        respond(400, { error: "path required" });
        return;
      }
      let real;
      try {
        real = realpathSync(requestedPath);
      } catch {
        respond(404, { error: "not found" });
        return;
      }
      if (!index.isAllowed(real)) {
        respond(403, { error: "path not in whitelist" });
        return;
      }
      // execFile (never a shell string) — `real` came from realpathSync, but
      // the whitelist check, not the API, is what stops an arbitrary open.
      // Platform-aware: `open -R` on macOS, `explorer /select,` on Windows,
      // `xdg-open <dirname>` on Linux.
      const { cmd, args } = revealCommand(real, parsed.reveal, platform);
      execFileFn(cmd, args, (error) => {
        // explorer.exe returns exit code 1 even on success — it detaches and
        // never reports the spawned window's status — so on Windows a non-zero
        // exit is not a real failure (the path is whitelisted + realpath'd, so
        // it exists). macOS `open` returns 0 on success and is reported normally.
        if (error && cmd !== "explorer") {
          console.error("[outputs] open failed:", error);
          respond(500, { error: "open failed" });
          return;
        }
        respond(200, { ok: true });
      });
    });
    return true;
  };
}
