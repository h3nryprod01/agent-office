// lane L7: the document workspace. Browse, read, comment on, approve and edit the documents
// and deliverables that live in a project's working directory (`project.json` → `cwd`).
//
//   GET  /docs?project=<slug>                    file list (+ review status, caller's role)
//   GET  /docs/doc?project=&path=                one document: text (when textual) + metadata
//   GET  /docs/file?project=&path=               raw bytes, for <iframe>/<img>/<embed>
//   GET  /docs/versions?project=&path=           git history if the file is in a repo, else saved snapshots
//   GET  /docs/version?project=&path=&id=        the text of one version
//   POST /docs/save | comment | comment/resolve | status | review
//
// Security model. The daemon only binds loopback, but any page in the user's browser can still
// fetch() a localhost port, so every path here is untrusted input:
//   1. `path` must be a relative, `/`-separated string with no `..`, `.`, empty or dot-prefixed
//      segment (so `.git/`, `.env`, `.ssh/` can never be read, even through a symlink);
//   2. only a fixed set of document extensions is served;
//   3. the target is realpath'd and must stay inside the realpath of the project's cwd — that is
//      the check that stops a symlink pointing out of the project (the string checks alone can't);
//   4. the project's cwd itself must still realpath into the user's home (project.json is a file
//      on disk — someone may have edited it).
// Writes only ever replace an EXISTING markdown file; there is no way to create or delete files.
//
// Roles (`owner` | `manager` | `viewer`): viewers read; managers and owners comment, review, edit.
// ponytail: `roleOf` defaults to "loopback = owner, everything else = no role" until L1's
// `roleOf(req)` (access.json) lands. Junction: pass it as `createDocsHttpHandler({ roleOf })` in index.js.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PROJECTS_DIR, PROJECT_SLUG_RE, addItem, readProject } from "./projects.js";

export const DOC_STATUSES = ["draft", "review", "approved"];
const KIND_BY_EXT = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".html": "html",
  ".htm": "html",
  ".csv": "csv",
};
const MIME_BY_EXT = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};
const TEXT_KINDS = new Set(["markdown", "text", "csv"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "__pycache__", "vendor"]);
const MAX_FILES = 3000;
const MAX_DEPTH = 8;
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // read
const MAX_SAVE_BYTES = 1024 * 1024; // write
const MAX_RAW_BYTES = 100 * 1024 * 1024;
const MAX_HISTORY = 20;
const COMMENT_MAX = 2000;
const NOTE_MAX = 500;
const GIT_REV_RE = /^[0-9a-f]{7,40}$/;
const SNAPSHOT_ID_RE = /^v-[a-z0-9]+$/;

const CAN_READ = new Set(["owner", "manager", "viewer"]);
const CAN_WRITE = new Set(["owner", "manager"]);

const STATUS_BY_CODE = {
  INVALID: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_LARGE: 413,
  UNSUPPORTED: 415,
};

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  err.extra = extra;
  return err;
}
const invalid = (m) => fail("INVALID", m);
const forbidden = (m) => fail("FORBIDDEN", m);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Loopback → owner; any other source has no role. The stand-in for L1's roleOf(req).
 * The Host header must be loopback too: a DNS-rebinding page reaches this socket from 127.0.0.1
 * but still carries its own hostname in Host (and, for POSTs, an Origin the guard already refuses).
 */
export function loopbackRole(req) {
  const addr = req.socket?.remoteAddress;
  if (addr !== "127.0.0.1" && addr !== "::1" && addr !== "::ffff:127.0.0.1") return null;
  const host = String(req.headers?.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(host) ? "owner" : null;
}

// ---- paths -----------------------------------------------------------------------------------

function kindOfPath(p) {
  return KIND_BY_EXT[path.extname(p).toLowerCase()] ?? null;
}

function isInside(root, real) {
  return real === root || real.startsWith(root + path.sep);
}

/** Throws unless `rel` is a plain relative `a/b/c.md` path. Returns its segments. */
function assertRelPath(rel) {
  if (typeof rel !== "string" || rel === "" || rel.length > 500) throw invalid("path is required");
  if (rel.includes("\0")) throw invalid("invalid path");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.includes("\\")) {
    throw invalid("path must be relative to the project folder");
  }
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw invalid("invalid path");
  if (segments.some((s) => s.startsWith("."))) throw forbidden("hidden files are not available");
  return segments;
}

/** The project's cwd, realpath'd and re-checked to sit inside `homeDir`. */
function projectRoot({ projectsDir, homeDir, slug }) {
  if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) throw invalid("invalid project");
  const project = readProject({ projectsDir, slug }); // NOT_FOUND if there is no such project
  let root;
  let home;
  try {
    root = fs.realpathSync(project.cwd);
    home = fs.realpathSync(homeDir);
  } catch {
    throw fail("NOT_FOUND", "the project folder is missing");
  }
  if (!fs.statSync(root).isDirectory() || !isInside(home, root) || root === home) {
    throw forbidden("the project folder is outside the home directory");
  }
  return { project, root };
}

/** Validate + resolve a document path to an existing, in-project, supported file. */
function resolveDoc(root, rel) {
  const segments = assertRelPath(rel);
  if (!kindOfPath(rel)) throw fail("UNSUPPORTED", "this file type is not a document");
  let real;
  try {
    real = fs.realpathSync(path.join(root, ...segments));
  } catch {
    throw fail("NOT_FOUND", "no such document");
  }
  if (!isInside(root, real)) throw forbidden("path escapes the project folder");
  // A link can also point at something INSIDE the project that is off-limits (.git/config).
  const realSegments = path.relative(root, real).split(path.sep);
  if (realSegments.some((s) => s.startsWith("."))) throw forbidden("hidden files are not available");
  if (!kindOfPath(real)) throw fail("UNSUPPORTED", "this file type is not a document");
  const st = fs.statSync(real);
  if (!st.isFile()) throw fail("NOT_FOUND", "no such document");
  return { real, rel: segments.join("/"), st, kind: kindOfPath(real) };
}

// ---- metadata (docs-meta.json) ---------------------------------------------------------------

const projectDir = (projectsDir, slug) => path.join(projectsDir, slug);
const metaFile = (projectsDir, slug) => path.join(projectDir(projectsDir, slug), "docs-meta.json");

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Missing → empty. Corrupt → set the bad file aside (it holds people's comments) and start empty. */
function readMeta(projectsDir, slug) {
  const file = metaFile(projectsDir, slug);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { version: 1, docs: {} };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.docs === "object" && parsed.docs !== null) return parsed;
    throw new Error("no docs object");
  } catch (error) {
    const aside = `${file.replace(/\.json$/, "")}.corrupt-${Date.now()}.json`;
    console.warn(`[docs] docs-meta.json unreadable (${error.message}); kept as ${path.basename(aside)}`);
    fs.renameSync(file, aside);
    return { version: 1, docs: {} };
  }
}

const emptyDoc = () => ({ status: "draft", statusAt: null, comments: [], reviews: [], history: [] });
const docOf = (meta, rel) => ({ ...emptyDoc(), ...(meta.docs[rel] ?? {}) });

/** Read-modify-write one document's metadata. `fn` returns the NEW doc record (never mutates). */
function updateDoc(projectsDir, slug, rel, fn) {
  const meta = readMeta(projectsDir, slug);
  const next = fn(docOf(meta, rel));
  writeJsonAtomic(metaFile(projectsDir, slug), { ...meta, version: 1, docs: { ...meta.docs, [rel]: next } });
  return next;
}

// ---- listing ---------------------------------------------------------------------------------

async function listFiles(root) {
  const out = [];
  async function walk(dir, depth) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue; // never followed in a listing
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const kind = kindOfPath(entry.name);
        if (!kind) continue;
        const st = await fsp.stat(full).catch(() => null);
        if (st) {
          out.push({
            path: path.relative(root, full).split(path.sep).join("/"),
            name: entry.name,
            kind,
            size: st.size,
            mtime: st.mtimeMs,
          });
        }
      }
    }
  }
  await walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---- versions --------------------------------------------------------------------------------

function git(root, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "--no-pager", ...args],
      { timeout: 5000, maxBuffer: MAX_TEXT_BYTES + 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function listVersions({ root, rel, st, doc }) {
  const current = { id: "current", current: true, at: new Date(st.mtimeMs).toISOString(), label: "", by: null };
  const log = await git(root, ["log", "-n", "30", "--format=%H%x1f%an%x1f%aI%x1f%s", "--", rel]);
  const commits = (log ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, by, at, label] = line.split("\x1f");
      return { id, by, at, label, current: false };
    });
  if (commits.length > 0) return { source: "git", versions: [current, ...commits] };
  const snapshots = [...doc.history].reverse().map((h) => ({ id: h.id, at: h.at, by: h.by, label: "", current: false }));
  return { source: "snapshots", versions: [current, ...snapshots] };
}

async function readVersion({ root, rel, real, doc, projectsDir, slug, id }) {
  if (id === "current") return fsp.readFile(real, "utf8");
  if (GIT_REV_RE.test(id)) {
    const text = await git(root, ["show", `${id}:./${rel}`]);
    if (text === null) throw fail("NOT_FOUND", "no such version");
    return text;
  }
  if (SNAPSHOT_ID_RE.test(id) && doc.history.some((h) => h.id === id)) {
    try {
      return await fsp.readFile(snapshotFile(projectsDir, slug, rel, id), "utf8");
    } catch {
      throw fail("NOT_FOUND", "that version is gone");
    }
  }
  throw invalid("invalid version id");
}

const snapshotDir = (projectsDir, slug, rel) =>
  path.join(projectDir(projectsDir, slug), "docs-history", createHash("sha1").update(rel).digest("hex").slice(0, 16));
const snapshotFile = (projectsDir, slug, rel, id) => path.join(snapshotDir(projectsDir, slug, rel), `${id}.txt`);

/** Keep the text being replaced so a bad edit can be recovered. Returns the new history list. */
function snapshot({ projectsDir, slug, rel, previous, role, history }) {
  const id = `v-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
  fs.mkdirSync(snapshotDir(projectsDir, slug, rel), { recursive: true });
  fs.writeFileSync(snapshotFile(projectsDir, slug, rel, id), previous);
  const next = [...history, { id, at: new Date().toISOString(), by: role, size: Buffer.byteLength(previous) }];
  const dropped = next.slice(0, Math.max(0, next.length - MAX_HISTORY));
  for (const old of dropped) fs.rmSync(snapshotFile(projectsDir, slug, rel, old.id), { force: true });
  return next.slice(dropped.length);
}

// ---- operations ------------------------------------------------------------------------------

function publicDoc(doc) {
  return { status: doc.status, statusAt: doc.statusAt, comments: doc.comments, reviews: doc.reviews };
}

function singleLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function reviewItemTitle(rel, note) {
  const head = `Revise "${rel}": `;
  const room = 200 - head.length;
  const line = singleLine(note);
  return head + (line.length > room ? `${line.slice(0, Math.max(0, room - 1))}…` : line);
}

function cleanText(value, max, what) {
  if (typeof value !== "string") throw invalid(`${what} must be a string`);
  const text = value.trim();
  if (text.length < 1 || text.length > max) throw invalid(`${what} must be 1–${max} characters`);
  return text;
}

const optionalText = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Every mutating action, keyed by route. Each gets {ctx, role, body} and returns [status, payload]. */
const ACTIONS = {
  "/docs/save"({ projectsDir, root, slug }, role, body) {
    const { real, rel, kind, st } = resolveDoc(root, body.path);
    if (kind !== "markdown") throw fail("UNSUPPORTED", "only markdown documents can be edited");
    if (typeof body.content !== "string") throw invalid("content must be a string");
    if (body.content.includes("\0")) throw invalid("content must be text");
    if (Buffer.byteLength(body.content) > MAX_SAVE_BYTES) throw fail("TOO_LARGE", "document is too large to save");
    if (typeof body.baseMtime === "number" && Math.trunc(body.baseMtime) !== Math.trunc(st.mtimeMs)) {
      throw fail("CONFLICT", "the file changed on disk since you opened it", { mtime: st.mtimeMs });
    }
    const previous = fs.readFileSync(real, "utf8");
    if (previous === body.content) return [200, { ok: true, mtime: st.mtimeMs, size: st.size, status: docOf(readMeta(projectsDir, slug), rel).status }];

    // snapshot first: if the write fails the old text is still recoverable
    // random name + exclusive create: a link planted at a guessable temp path cannot redirect the write
    const tmp = `${real}.ao-tmp-${randomUUID().slice(0, 8)}`;
    let doc;
    try {
      fs.writeFileSync(tmp, body.content, { mode: st.mode & 0o777, flag: "wx" });
      const history = snapshot({ projectsDir, slug, rel, previous, role, history: docOf(readMeta(projectsDir, slug), rel).history });
      fs.renameSync(tmp, real);
      doc = updateDoc(projectsDir, slug, rel, (d) => ({
        ...d,
        history,
        // an approval covered the text that was just replaced
        status: d.status === "approved" ? "draft" : d.status,
        statusAt: d.status === "approved" ? new Date().toISOString() : d.statusAt,
      }));
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const after = fs.statSync(real);
    return [200, { ok: true, mtime: after.mtimeMs, size: after.size, status: doc.status }];
  },

  "/docs/comment"({ projectsDir, root, slug }, role, body) {
    const { rel } = resolveDoc(root, body.path);
    const text = cleanText(body.text, COMMENT_MAX, "text");
    const comment = {
      id: `c-${randomUUID().slice(0, 8)}`,
      text,
      anchor: {
        heading: optionalText(body.anchor?.heading, 200),
        quote: optionalText(body.anchor?.quote, 200),
      },
      author: optionalText(body.author, 60),
      by: role,
      createdAt: new Date().toISOString(),
      resolved: false,
    };
    updateDoc(projectsDir, slug, rel, (d) => ({ ...d, comments: [...d.comments, comment] }));
    return [201, comment];
  },

  "/docs/comment/resolve"({ projectsDir, root, slug }, role, body) {
    const { rel } = resolveDoc(root, body.path);
    if (!docOf(readMeta(projectsDir, slug), rel).comments.some((c) => c.id === body.id)) {
      throw fail("NOT_FOUND", "no such comment");
    }
    const resolved = body.resolved !== false;
    updateDoc(projectsDir, slug, rel, (d) => ({
      ...d,
      comments: d.comments.map((c) => (c.id === body.id ? { ...c, resolved } : c)),
    }));
    return [200, { ok: true, resolved }];
  },

  "/docs/status"({ projectsDir, root, slug }, role, body) {
    const { rel } = resolveDoc(root, body.path);
    // "approved" is deliberately not settable here: approving is a review decision with a record.
    if (body.status !== "draft" && body.status !== "review") throw invalid('status must be "draft" or "review"');
    const doc = updateDoc(projectsDir, slug, rel, (d) => ({ ...d, status: body.status, statusAt: new Date().toISOString() }));
    return [200, { ok: true, status: doc.status }];
  },

  "/docs/review"({ projectsDir, root, slug }, role, body) {
    const { rel } = resolveDoc(root, body.path);
    if (body.decision !== "approve" && body.decision !== "changes") throw invalid('decision must be "approve" or "changes"');
    const note = body.decision === "changes" ? cleanText(body.note, NOTE_MAX, "note") : optionalText(body.note, NOTE_MAX);
    const at = new Date().toISOString();
    // The item comes first: if it cannot be created, no review is recorded for a request nobody will see.
    const item =
      body.decision === "changes"
        ? addItem({ projectsDir, slug, title: reviewItemTitle(rel, note), source: "human", status: "idea", links: { doc: rel } })
        : null;
    const review = { id: `r-${randomUUID().slice(0, 8)}`, decision: body.decision, note, by: role, at, itemId: item?.id ?? null };
    const status = body.decision === "approve" ? "approved" : "draft";
    updateDoc(projectsDir, slug, rel, (d) => ({ ...d, status, statusAt: at, reviews: [...d.reviews, review] }));
    return [200, { ok: true, status, review, item }];
  },
};

// ---- http ------------------------------------------------------------------------------------

const GET_ROUTES = ["/docs", "/docs/doc", "/docs/file", "/docs/versions", "/docs/version"];

function readBody(req, limit, done) {
  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    if (tooBig) return;
    body += chunk;
    if (body.length > limit) {
      tooBig = true;
      body = "";
    }
  });
  req.on("end", () => {
    if (tooBig) return done(fail("TOO_LARGE", "request body is too large"));
    try {
      done(null, JSON.parse(body));
    } catch {
      done(invalid("body must be JSON"));
    }
  });
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.projectsDir]
 * @param {string} [opts.homeDir]   a project's cwd must realpath inside this
 * @param {(req) => ("owner"|"manager"|"viewer"|null)} [opts.roleOf]
 */
export function createDocsHttpHandler({
  projectsDir = DEFAULT_PROJECTS_DIR,
  homeDir = os.homedir(),
  roleOf = loopbackRole,
} = {}) {
  return (req, res, url) => {
    const isGet = GET_ROUTES.includes(url.pathname);
    const isPost = Object.hasOwn(ACTIONS, url.pathname);
    if (!isGet && !isPost) return false;

    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    };
    const onError = (error) => {
      const status = STATUS_BY_CODE[error.code];
      if (status) return json(status, { error: error.message, ...error.extra });
      console.error("[docs] error:", error);
      json(500, { error: "server error" });
    };

    if (req.method !== (isGet ? "GET" : "POST")) {
      json(405, { error: "method not allowed" });
      return true;
    }

    let role;
    try {
      role = roleOf(req);
      if (!CAN_READ.has(role)) throw forbidden("not allowed");
    } catch (error) {
      onError(error);
      return true;
    }

    if (isPost) {
      if (!CAN_WRITE.has(role)) {
        json(403, { error: "your role is read-only" });
        return true;
      }
      readBody(req, 2.5 * 1024 * 1024, (bodyError, body) => {
        try {
          if (bodyError) throw bodyError;
          const slug = body?.project;
          const ctx = { projectsDir, slug, ...projectRoot({ projectsDir, homeDir, slug }) };
          const [status, payload] = ACTIONS[url.pathname](ctx, role, body);
          json(status, payload);
        } catch (error) {
          onError(error);
        }
      });
      return true;
    }

    handleGet({ url, role, projectsDir, homeDir, res, json }).catch(onError);
    return true;
  };
}

async function handleGet({ url, role, projectsDir, homeDir, res, json }) {
  const slug = url.searchParams.get("project");
  const { root } = projectRoot({ projectsDir, homeDir, slug });

  if (url.pathname === "/docs") {
    const meta = readMeta(projectsDir, slug);
    const files = (await listFiles(root)).map((f) => ({ ...f, status: docOf(meta, f.path).status }));
    return json(200, { files, role });
  }

  const { real, rel, st, kind } = resolveDoc(root, url.searchParams.get("path"));

  if (url.pathname === "/docs/file") {
    if (st.size > MAX_RAW_BYTES) throw fail("TOO_LARGE", "file is too large");
    const headers = {
      "content-type": MIME_BY_EXT[path.extname(real).toLowerCase()],
      "content-length": st.size,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    };
    // A document may carry script. `sandbox` gives it an opaque origin, so even opened directly it
    // cannot reach the daemon's API as the user. (Not applied to PDF — Chrome's viewer needs to run.)
    if (kind === "html") headers["content-security-policy"] = "sandbox";
    res.writeHead(200, headers);
    fs.createReadStream(real).on("error", () => res.destroy()).pipe(res);
    return undefined;
  }

  const doc = docOf(readMeta(projectsDir, slug), rel);

  if (url.pathname === "/docs/doc") {
    const info = { path: rel, name: path.basename(rel), kind, size: st.size, mtime: st.mtimeMs, role, ...publicDoc(doc) };
    if (TEXT_KINDS.has(kind)) {
      if (st.size > MAX_TEXT_BYTES) throw fail("TOO_LARGE", "document is too large to display");
      info.content = await fsp.readFile(real, "utf8");
    }
    return json(200, info);
  }

  if (url.pathname === "/docs/versions") {
    return json(200, await listVersions({ root, rel, st, doc }));
  }

  // /docs/version
  if (!TEXT_KINDS.has(kind)) throw fail("UNSUPPORTED", "only text documents have readable versions");
  const id = url.searchParams.get("id") ?? "";
  const content = await readVersion({ root, rel, real, doc, projectsDir, slug, id });
  return json(200, { id, content });
}
