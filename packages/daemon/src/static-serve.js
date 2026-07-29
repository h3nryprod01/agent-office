// R13-INFRA: serve the renderer's built `dist/` from the daemon itself — one
// process, one port (8787). Lets "open the app" be just hitting the daemon URL,
// no separate Vite dev server. This handler runs LAST in the extraHttp chain so
// it can't shadow API routes (it's a GET catch-all over a fixed distDir).
//
// Security: traversal is refused three ways. (1) A raw-path guard rejects
// `..`/`%2e`/`%2f`/`%5c`/`%00`/`\` up front with 403 — matching the repo idiom
// (R13-A slugify rejects traversal-shaped input rather than relying on parser
// quirks). (2) The WHATWG URL parser already collapses literal `..` and encoded
// `%2e%2e` so they can't escape root. (3) A path.resolve + startsWith backstop
// refuses anything that nonetheless resolves outside distDir. No path is ever
// joined raw.

import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** packages/renderer/dist relative to this file (packages/daemon/src/). */
export const DEFAULT_DIST_DIR = fileURLToPath(new URL("../../renderer/dist/", import.meta.url));

// Refuse traversal-shaped input. A `/` or `\` followed by two dots is a
// dot-dot segment; `%2e`/`%2f`/`%5c`/`%00` are encoded `.`/`/`/`\`/NUL. Vite's
// content-hashed asset names contain none of these, so no legit file is refused.
const TRAVERSAL_RE = /(?:[\\/]\.\.)|%2e|%2f|%5c|%00|\\/i;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Build the extraHttp handler that serves dist/ as a static SPA.
 * @param {{distDir?: string, devMode?: boolean}} opts
 *   - distDir: root of the built renderer (default packages/renderer/dist)
 *   - devMode: when true, always returns false (dev keeps using Vite:5199, so a
 *     stale build can't trap the user). Logged once at init.
 * @returns {(req, res, url) => boolean} true once a static route was handled.
 */
export function createStaticHttpHandler({
  distDir = DEFAULT_DIST_DIR,
  devMode = process.env.AGENT_OFFICE_DEV === "1",
} = {}) {
  const root = path.resolve(distDir);
  if (devMode) {
    console.log("[static-serve] OFF (AGENT_OFFICE_DEV=1) — dùng Vite:5199");
    return () => false;
  }

  return (req, res, url) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    // (1) raw-path guard. req.url is the raw request target (still encoded);
    // fall back to the parsed pathname+search only if a synthetic req omits it.
    const rawPath = req.url ?? url.pathname + url.search;
    if (TRAVERSAL_RE.test(rawPath)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("403 forbidden");
      return true;
    }

    const indexPath = path.join(root, "index.html");
    const pathname = url.pathname;
    // `/` and `/index.html` → index.html. Everything else resolves under root.
    // "." + pathname keeps the join relative so path.resolve normalizes it; the
    // startsWith check (3) is the backstop for anything that nonetheless escaped.
    const target =
      pathname === "/" || pathname === "/index.html"
        ? indexPath
        : path.resolve(root, "." + pathname);
    if (target !== indexPath && !target.startsWith(root + path.sep)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("403 forbidden");
      return true;
    }

    // No build yet → yield to the next handler (404), don't pretend to serve.
    if (!existsSync(root) || !existsSync(indexPath)) return false;

    // Real file → serve it; otherwise SPA fallback to index.html (query-param
    // routing, no server-side path routes). HEAD sets headers only, no body.
    const filePath = existsSync(target) && statSync(target).isFile() ? target : indexPath;
    serveFile(res, filePath, req.method === "HEAD");
    return true;
  };
}

function serveFile(res, filePath, headOnly) {
  const headers = { "content-type": contentTypeFor(filePath) };
  // ponytail: index.html always revalidated (new deploys roll forward); every
  // other file is content-hashed by Vite so it's effectively immutable —
  // max-age=3600 across the board instead of hashing a per-file immutability rule.
  if (path.basename(filePath) === "index.html") {
    headers["cache-control"] = "no-cache";
  } else {
    headers["cache-control"] = "public, max-age=3600";
  }
  try {
    if (headOnly) {
      headers["content-length"] = statSync(filePath).size;
      res.writeHead(200, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    const stream = createReadStream(filePath);
    stream.on("error", (error) => {
      console.error(`[static-serve] read failed ${filePath}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("500 internal error");
    });
    stream.pipe(res);
  } catch (error) {
    console.error(`[static-serve] serve failed ${filePath}: ${error.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("500 internal error");
  }
}
