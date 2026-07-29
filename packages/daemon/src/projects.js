// R13-A: the daemon owns project + work-item data. A project is a directory under
// ~/.agent-office/projects/<slug>/ — project.json, roster.yaml, goals.md, items.json.
//
// Two writers race here (the office UI and a chip that finished a task), so every
// items.json write is write-tmp + rename. When the daemon is down a chip appends to
// items-outbox.jsonl instead; readItems drains that back in.
//
// The daemon binds 127.0.0.1, but any page in the user's browser can fetch() a
// localhost port. So POST /projects is treated as untrusted input: `template` goes
// through templateNames(), `name` may not contain path separators, and `cwd` must
// realpath to a directory inside the user's home.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { templateNames } from "../../../scripts/company-template-lib.mjs";
import { DEFAULT_TEMPLATES_DIR } from "./templates.js";

export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const ITEM_SOURCES = ["human", "agent"];
export const ITEM_STATUSES = ["idea", "doing", "review", "done", "dropped"];
export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".agent-office", "projects");

const TITLE_MAX = 200;
const PATCHABLE = ["title", "status", "assignee", "fromIdea", "links"];
const LINK_KEYS = ["pr", "plane", "obsidian", "branch"];
/** These two are rendered as clickable links — a `javascript:` value would be an injection. */
const URL_LINK_KEYS = new Set(["pr", "plane"]);
const LINK_MAX = 500;

/** Caller-fault error: HTTP maps `code` to 400/409/404, everything else to 500. */
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const invalid = (m) => fail("INVALID", m);

/**
 * `"Agent Office!"` → `"agent-office"`. Rejects anything with a path separator or `..`
 * BEFORE slugifying — otherwise `"../evil"` would quietly slug to a valid `"evil"` and
 * the traversal attempt would look like a normal create.
 */
export function slugify(name) {
  if (typeof name !== "string" || name.trim() === "") throw invalid("project name is required");
  if (/[/\\]|\.\./.test(name)) throw invalid(`invalid project name: ${JSON.stringify(name)}`);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!PROJECT_SLUG_RE.test(slug)) throw invalid(`invalid project name: ${JSON.stringify(name)}`);
  return slug;
}

/** write-tmp + rename. Two writers (UI + chip) — a plain overwrite yields a torn JSON file. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function projectDir(projectsDir, slug) {
  if (!PROJECT_SLUG_RE.test(slug)) throw invalid(`invalid slug: ${JSON.stringify(slug)}`);
  return path.join(projectsDir, slug);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Throws INVALID unless `cwd` is an absolute path realpath-ing to a directory inside `homeDir`. */
function assertCwdInHome(cwd, homeDir) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw invalid(`cwd must be an absolute path`);
  let real;
  let realHome;
  try {
    real = fs.realpathSync(cwd);
    realHome = fs.realpathSync(homeDir);
  } catch {
    throw invalid(`cwd does not exist: ${cwd}`);
  }
  if (!fs.statSync(real).isDirectory()) throw invalid(`cwd is not a directory: ${cwd}`);
  if (real !== realHome && !real.startsWith(realHome + path.sep)) {
    throw invalid(`cwd must be inside ${realHome}`);
  }
  return real;
}

function assertTitle(title) {
  if (typeof title !== "string") throw invalid("title must be a string");
  const trimmed = title.trim();
  if (trimmed.length < 1 || trimmed.length > TITLE_MAX) {
    throw invalid(`title must be 1–${TITLE_MAX} characters`);
  }
  return trimmed;
}

/**
 * Normalize `links` to exactly the four known keys. `pr` and `plane` must be http(s)
 * URLs — the UI turns them into anchors, so `javascript:` must never reach the disk.
 * `branch` and `obsidian` are not URLs (a git ref, a vault-relative note path).
 */
function assertLinks(links) {
  if (links === null || typeof links !== "object" || Array.isArray(links)) {
    throw invalid("links must be an object");
  }
  const out = { pr: null, plane: null, obsidian: null, branch: null };
  for (const [key, value] of Object.entries(links)) {
    if (!LINK_KEYS.includes(key)) throw invalid(`links: unknown field "${key}"`);
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || value.length > LINK_MAX) {
      throw invalid(`links.${key} must be a string of at most ${LINK_MAX} characters`);
    }
    if (URL_LINK_KEYS.has(key)) {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        throw invalid(`links.${key} is not a URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw invalid(`links.${key} accepts http/https only`);
      }
    }
    out[key] = value;
  }
  return out;
}

/** @returns {{slug,name,template,cwd,counts:{human,agent}}[]} — missing projectsDir → []. */
export function listProjects({ projectsDir = DEFAULT_PROJECTS_DIR } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = readProject({ projectsDir, slug: e.name });
      const items = readItems({ projectsDir, slug: e.name });
      out.push({
        slug: meta.slug,
        name: meta.name,
        template: meta.template,
        cwd: meta.cwd,
        counts: {
          human: items.filter((i) => i.source === "human").length,
          agent: items.filter((i) => i.source === "agent").length,
        },
      });
    } catch (error) {
      console.warn(`[projects] skipping "${e.name}" (${error.message})`);
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readProject({ projectsDir = DEFAULT_PROJECTS_DIR, slug }) {
  const dir = projectDir(projectsDir, slug);
  try {
    return readJson(path.join(dir, "project.json"));
  } catch {
    throw fail("NOT_FOUND", `no such project "${slug}"`);
  }
}

export function createProject({
  projectsDir = DEFAULT_PROJECTS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  homeDir = os.homedir(),
  name,
  template,
  cwd,
  now = new Date().toISOString(),
}) {
  const slug = slugify(name);
  if (!templateNames(templatesDir).includes(template)) {
    throw invalid(`no such template "${template}"`);
  }
  const realCwd = assertCwdInHome(cwd, homeDir);

  const dir = projectDir(projectsDir, slug);
  if (fs.existsSync(dir)) throw fail("EXISTS", `project "${slug}" already exists`);

  const templateDir = path.join(templatesDir, template);
  fs.mkdirSync(dir, { recursive: true });
  const project = { version: 1, slug, name: String(name), template, cwd: realCwd, createdAt: now };
  writeJsonAtomic(path.join(dir, "project.json"), project);
  writeJsonAtomic(path.join(dir, "items.json"), { version: 1, items: [] });
  fs.copyFileSync(path.join(templateDir, "roster.yaml"), path.join(dir, "roster.yaml"));
  fs.copyFileSync(path.join(templateDir, "goals.md"), path.join(dir, "goals.md"));
  return project;
}

/** Coerce one outbox line / API payload into a stored item. Throws INVALID. */
function makeItem({ id, title, source, status, fromIdea = null, assignee = null, links = {}, now }) {
  const clean = assertTitle(title);
  if (!ITEM_SOURCES.includes(source)) throw invalid(`source must be one of ${ITEM_SOURCES.join("|")}`);
  const finalStatus = status ?? (source === "human" ? "idea" : "doing");
  if (!ITEM_STATUSES.includes(finalStatus)) throw invalid(`status must be one of ${ITEM_STATUSES.join("|")}`);
  return {
    id: id ?? `it-${randomUUID().slice(0, 8)}`,
    title: clean,
    source,
    status: finalStatus,
    createdAt: now,
    updatedAt: now,
    fromIdea,
    assignee,
    links: assertLinks(links),
  };
}

/**
 * Fold items-outbox.jsonl — where a chip appends while the daemon is down — into items.json.
 *
 * The outbox is RENAMED before it is read. Truncating it afterwards would silently drop any
 * line a chip appended while we were parsing; after the rename the chip writes to a fresh
 * file we have not claimed. A crash between the rename and the write leaves the staging file
 * behind, so drain a leftover one before claiming a new one.
 *
 * A line we cannot turn into an item goes to items-outbox.corrupt, never to /dev/null — it is
 * someone's work item, and a human can still read it.
 *
 * ponytail: staging is unlinked AFTER items.json is written, so a crash in between replays the
 * drain and can duplicate an item. Duplicates are visible on the board; lost work is not.
 */
function drainOutbox(dir, itemsFile, raw) {
  const outbox = path.join(dir, "items-outbox.jsonl");
  const staging = `${outbox}.draining`;
  if (!fs.existsSync(staging)) {
    try {
      fs.renameSync(outbox, staging);
    } catch {
      return raw; // no outbox — the common case
    }
  }

  const drained = [];
  const corrupt = [];
  for (const line of fs.readFileSync(staging, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      drained.push(makeItem({ ...parsed, now: parsed.createdAt ?? new Date().toISOString() }));
    } catch (error) {
      console.warn(`[projects] outbox kept a malformed line (${error.message})`);
      corrupt.push(line);
    }
  }

  const next = drained.length > 0 ? { ...raw, items: [...raw.items, ...drained] } : raw;
  if (drained.length > 0) writeJsonAtomic(itemsFile, next);
  if (corrupt.length > 0) fs.appendFileSync(path.join(dir, "items-outbox.corrupt"), `${corrupt.join("\n")}\n`);
  fs.unlinkSync(staging);
  return next;
}

/** Items on the board, outbox folded in first. */
export function readItems({ projectsDir = DEFAULT_PROJECTS_DIR, slug, source } = {}) {
  const dir = projectDir(projectsDir, slug);
  const itemsFile = path.join(dir, "items.json");

  let raw;
  try {
    raw = readJson(itemsFile);
  } catch {
    throw fail("NOT_FOUND", `no such project "${slug}"`);
  }
  if (!Array.isArray(raw.items)) throw invalid(`${itemsFile}: missing the "items" array`);

  raw = drainOutbox(dir, itemsFile, raw);
  return source ? raw.items.filter((i) => i.source === source) : raw.items;
}

export function addItem({ projectsDir = DEFAULT_PROJECTS_DIR, slug, now = new Date().toISOString(), ...fields }) {
  const items = readItems({ projectsDir, slug });
  const item = makeItem({ ...fields, now });
  writeJsonAtomic(path.join(projectDir(projectsDir, slug), "items.json"), {
    version: 1,
    items: [...items, item],
  });
  return item;
}

export function updateItem({
  projectsDir = DEFAULT_PROJECTS_DIR,
  slug,
  id,
  patch = {},
  now = new Date().toISOString(),
}) {
  const items = readItems({ projectsDir, slug });
  const index = items.findIndex((i) => i.id === id);
  if (index === -1) throw fail("NOT_FOUND", `no such item "${id}"`);

  const changes = {};
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE.includes(key)) throw invalid(`field "${key}" is not editable`);
    changes[key] = patch[key];
  }
  if ("title" in changes) changes.title = assertTitle(changes.title);
  if ("status" in changes && !ITEM_STATUSES.includes(changes.status)) {
    throw invalid(`status must be one of ${ITEM_STATUSES.join("|")}`);
  }
  if ("links" in changes) {
    // Only the keys the caller actually sent may change. assertLinks() fills the four keys
    // with null, so merging its whole result would wipe `plane` every time someone sets `pr`.
    // An explicit `{pr: null}` still clears — it is in the caller's own keys.
    const incoming = assertLinks(changes.links);
    const sent = Object.keys(changes.links).map((key) => [key, incoming[key]]);
    changes.links = { ...items[index].links, ...Object.fromEntries(sent) };
  }

  const updated = { ...items[index], ...changes, updatedAt: now };
  const next = items.map((i, n) => (n === index ? updated : i));
  writeJsonAtomic(path.join(projectDir(projectsDir, slug), "items.json"), { version: 1, items: next });
  return updated;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const ROUTES = ["/projects", "/items", "/items/update"];
const STATUS_BY_CODE = { INVALID: 400, EXISTS: 409, NOT_FOUND: 404 };

/**
 * GET /projects · POST /projects · GET /items?project=… · POST /items · POST /items/update.
 * Same extraHttp contract as the other daemon routes (true once handled).
 */
export function createProjectsHttpHandler({
  projectsDir = DEFAULT_PROJECTS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  homeDir = os.homedir(),
} = {}) {
  return (req, res, url) => {
    if (!ROUTES.includes(url.pathname)) return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    const respond = (statusCode, payload) => {
      res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    const guard = (fn) => {
      try {
        fn();
      } catch (error) {
        const status = STATUS_BY_CODE[error.code];
        if (status) {
          respond(status, { error: error.message });
          return;
        }
        console.error("[projects] error:", error);
        respond(500, { error: "server error" });
      }
    };

    const withBody = (fn) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy(); // an item never needs this much
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        guard(() => fn(parsed ?? {}));
      });
    };

    if (url.pathname === "/projects") {
      if (req.method === "GET") {
        guard(() => respond(200, listProjects({ projectsDir })));
        return true;
      }
      if (req.method !== "POST") {
        respond(405, { error: "method not allowed" });
        return true;
      }
      // Name every field taken from the body. Spreading it would let a request carry its own
      // `homeDir` / `projectsDir` / `templatesDir` and overwrite the server's — any page in
      // the browser can POST here, and that turns the cwd-inside-home check into decoration.
      withBody(({ name, template, cwd }) =>
        respond(201, createProject({ projectsDir, templatesDir, homeDir, name, template, cwd })),
      );
      return true;
    }

    if (url.pathname === "/items") {
      if (req.method === "GET") {
        const slug = url.searchParams.get("project");
        const source = url.searchParams.get("source") ?? undefined;
        guard(() => {
          if (!slug) throw invalid("missing ?project=");
          if (source && !ITEM_SOURCES.includes(source)) throw invalid(`source must be one of ${ITEM_SOURCES.join("|")}`);
          respond(200, { items: readItems({ projectsDir, slug, source }) });
        });
        return true;
      }
      if (req.method !== "POST") {
        respond(405, { error: "method not allowed" });
        return true;
      }
      // Named fields only — see POST /projects. `id` and `now` stay server-owned too.
      withBody(({ project, title, source, status, fromIdea, assignee, links }) =>
        respond(201, addItem({ projectsDir, slug: project, title, source, status, fromIdea, assignee, links })),
      );
      return true;
    }

    // /items/update
    if (req.method !== "POST") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    withBody(({ project, id, patch }) => respond(200, updateItem({ projectsDir, slug: project, id, patch })));
    return true;
  };
}
