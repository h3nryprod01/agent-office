// lane L2: reads/writes the `policy` key of a project's project.json, resolves
// "which project does this cwd belong to", and keeps the per-project audit log
// (~/.agent-office/projects/<slug>/policy-audit.jsonl).
//
// project.json is shared with other writers (projects.js creates it, L5 adds
// `members`), so setPolicy touches ONLY the `policy` key and renames atomically.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECTS_DIR, PROJECT_SLUG_RE } from "./projects.js";
import { normalizePolicy, validatePolicy } from "./policy.js";

const AUDIT_FILE = "policy-audit.jsonl";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export class PolicyStore {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.projectsDir]
   * @param {number} [opts.cacheMs] how long the project list is reused between requests
   * @param {number} [opts.auditMaxBytes] audit file size that triggers a trim
   * @param {number} [opts.auditKeepLines] lines kept by a trim
   */
  constructor({ projectsDir = DEFAULT_PROJECTS_DIR, cacheMs = 2000, auditMaxBytes = 512 * 1024, auditKeepLines = 1000 } = {}) {
    this.projectsDir = projectsDir;
    this.cacheMs = cacheMs;
    this.auditMaxBytes = auditMaxBytes;
    this.auditKeepLines = auditKeepLines;
    this.cache = null;
  }

  #dir(slug) {
    if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) throw fail("INVALID", `invalid slug: ${JSON.stringify(slug)}`);
    return path.join(this.projectsDir, slug);
  }

  /** @returns {{slug: string, name: string, cwd: string, policy: object, hasPolicy: boolean}[]} */
  projects() {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.list;
    let entries = [];
    try {
      entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      // no projects dir yet → nothing has a policy
    }
    const list = [];
    for (const e of entries) {
      if (!e.isDirectory() || !PROJECT_SLUG_RE.test(e.name)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.projectsDir, e.name, "project.json"), "utf8"));
        if (typeof meta.cwd !== "string" || meta.cwd === "") continue;
        list.push({
          slug: e.name,
          name: typeof meta.name === "string" ? meta.name : e.name,
          cwd: realOrSelf(meta.cwd),
          policy: normalizePolicy(meta.policy),
          hasPolicy: meta.policy !== undefined && meta.policy !== null,
        });
      } catch {
        // a corrupt project.json must not take the approval path down
      }
    }
    this.cache = { at: now, list };
    return list;
  }

  /** The project whose directory contains `cwd` (deepest wins), or null. */
  projectFor(cwd) {
    if (typeof cwd !== "string" || cwd === "") return null;
    const abs = realOrSelf(cwd);
    let best = null;
    for (const p of this.projects()) {
      if (abs !== p.cwd && !abs.startsWith(p.cwd + path.sep)) continue;
      if (!best || p.cwd.length > best.cwd.length) best = p;
    }
    return best;
  }

  getPolicy(slug) {
    this.#dir(slug);
    this.cache = null; // an explicit read should see edits made on disk by hand
    const project = this.projects().find((p) => p.slug === slug);
    if (!project) throw fail("NOT_FOUND", `no such project "${slug}"`);
    return project;
  }

  /** Validate, write only `policy`, return the normalized policy. */
  setPolicy(slug, input) {
    const policy = validatePolicy(input);
    const file = path.join(this.#dir(slug), "project.json");
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw fail("NOT_FOUND", `no such project "${slug}"`);
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...meta, policy }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    this.cache = null;
    return policy;
  }

  appendAudit(slug, entry) {
    const file = path.join(this.#dir(slug), AUDIT_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    try {
      if (fs.statSync(file).size > this.auditMaxBytes) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, `${lines.slice(-this.auditKeepLines).join("\n")}\n`);
        fs.renameSync(tmp, file);
      }
    } catch {
      // trimming is housekeeping; the entry itself is already on disk
    }
  }

  /** Newest first. Unparseable lines are skipped, a missing file is []. */
  readAudit(slug, limit = 100) {
    let text;
    try {
      text = fs.readFileSync(path.join(this.#dir(slug), AUDIT_FILE), "utf8");
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split("\n").reverse()) {
      if (rows.length >= limit) break;
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // skip a torn line
      }
    }
    return rows;
  }
}
