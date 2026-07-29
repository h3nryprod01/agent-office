// "Bảng lương" của công ty agent: aggregate token cost per (session, repo,
// hour, model, harness) across ALL THREE harnesses the daemon tails —
// Claude Code transcripts, Codex rollouts, Gemini CLI chat sessions.
// The per-format parsing lives in usage-parsers.js.
//
// Memory discipline (post-OOM #17): session content is NEVER retained — only
// numeric buckets are kept.
//
// Laziness: nothing is read at construction. Each /costs request triggers a
// rescan at most once per `scanTtlMs`; between scans, and for files whose
// (mtime, size) haven't changed, cached buckets are reused. Files older than
// `maxAgeMs` (the widest window, 30d) are never parsed at all. Re-parsing a
// changed file REPLACES that file's buckets, so a rewritten source (Gemini)
// can never double-count.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseClaudeFile, parseCodexFile, parseGeminiFile } from "./usage-parsers.js";

const HOUR_MS = 3_600_000;
export const WINDOWS_MS = { "24h": 24 * HOUR_MS, "7d": 7 * 24 * HOUR_MS, "30d": 30 * 24 * HOUR_MS };

/** Over budget only when a positive budget is set and total meets/exceeds it. Pure. */
export function overBudget(totalUsd, budgetUsd) {
  return typeof budgetUsd === "number" && budgetUsd > 0 && totalUsd >= budgetUsd;
}

export class UsageCostIndex {
  /**
   * @param {Object} opts
   * @param {string} opts.projectsRoot          ~/.claude/projects
   * @param {string} [opts.codexSessionsRoot]   ~/.codex/sessions (omit to skip)
   * @param {string} [opts.geminiTmpRoot]       ~/.gemini/tmp (omit to skip)
   * @param {number} [opts.scanTtlMs]           min interval between directory rescans
   * @param {number} [opts.maxAgeMs]            files with mtime older than this are skipped
   * @param {number} [opts.maxAgents]           byAgent rows returned (top by USD)
   */
  constructor({
    projectsRoot,
    codexSessionsRoot,
    geminiTmpRoot,
    scanTtlMs = 15_000,
    maxAgeMs = WINDOWS_MS["30d"],
    maxAgents = 20,
    budgetUsd = null,
  }) {
    this.projectsRoot = projectsRoot;
    this.codexSessionsRoot = codexSessionsRoot;
    this.geminiTmpRoot = geminiTmpRoot;
    this.scanTtlMs = scanTtlMs;
    this.maxAgeMs = maxAgeMs;
    this.maxAgents = maxAgents;
    this.budgetUsd = budgetUsd;
    this._overBudget = false;
    /** @type {Map<string, {mtimeMs:number, size:number, buckets:Object[]}>} keyed by file path */
    this.fileCache = new Map();
    this.lastScan = 0;
    this.stats = { filesParsed: 0 }; // observability + test hook
  }

  /** Last-computed over-budget flag, refreshed on each query(). Eventually
   * consistent — fine for a budget guard the office polls every few seconds. */
  overBudgetNow() {
    return this._overBudget;
  }

  /**
   * Aggregated costs for one window.
   * @param {"24h"|"7d"|"30d"} window
   */
  async query(window) {
    const windowMs = WINDOWS_MS[window];
    if (!windowMs) throw new RangeError(`unknown window: ${window}`);
    await this.#refresh();

    const cutoff = Math.floor((Date.now() - windowMs) / HOUR_MS) * HOUR_MS;
    const byRepo = new Map();
    const byAgent = new Map();
    const byDay = new Map();
    const byHarness = new Map();
    const unknownModels = new Map();
    const total = emptyRow();

    for (const { buckets } of this.fileCache.values()) {
      for (const b of buckets) {
        if (b.hour < cutoff) continue;
        addRow(total, b);
        addRow(mapRow(byRepo, b.repo, { repo: b.repo }), b);
        addRow(
          mapRow(byAgent, b.sessionId, { sessionId: b.sessionId, repo: b.repo, harness: b.harness }),
          b,
        );
        addRow(mapRow(byDay, dayOf(b.hour), { day: dayOf(b.hour) }), b);
        addRow(mapRow(byHarness, b.harness, { harness: b.harness }), b);
        // zero-token unknowns (e.g. "<synthetic>" error placeholders) are noise
        if (!b.known && b.tokens > 0)
          unknownModels.set(b.model, (unknownModels.get(b.model) ?? 0) + b.tokens);
      }
    }

    const desc = (a, b) => b.usd - a.usd || b.tokens - a.tokens;
    const totalUsd = round(total.usd);
    this._overBudget = overBudget(totalUsd, this.budgetUsd);
    return {
      window,
      totalUsd,
      budgetUsd: this.budgetUsd,
      overBudget: this._overBudget,
      tokensTotal: total.tokens,
      tokens: {
        input: total.input,
        output: total.output,
        cacheWrite: total.cacheWrite,
        cacheRead: total.cacheRead,
      },
      byRepo: [...byRepo.values()].sort(desc).map(roundRow),
      byAgent: [...byAgent.values()].sort(desc).slice(0, this.maxAgents).map(roundRow),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(roundRow),
      byHarness: [...byHarness.values()].sort(desc).map(roundRow),
      unknownModels: [...unknownModels.entries()].map(([model, tokens]) => ({ model, tokens })),
    };
  }

  async #refresh() {
    const now = Date.now();
    if (now - this.lastScan < this.scanTtlMs) return;
    this.lastScan = now;

    const targets = [
      ...(await claudeFiles(this.projectsRoot)),
      ...(await codexFiles(this.codexSessionsRoot)),
      ...(await geminiFiles(this.geminiTmpRoot)),
    ];

    const seen = new Set();
    for (const { filePath, parse } of targets) {
      let st;
      try {
        st = await stat(filePath);
      } catch {
        continue; // deleted between readdir and stat
      }
      if (now - st.mtimeMs > this.maxAgeMs) continue;
      seen.add(filePath);
      const cached = this.fileCache.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      this.stats.filesParsed += 1;
      const buckets = await parse();
      this.fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, buckets });
    }
    // drop cache entries for deleted/aged-out files so the map can't grow forever
    for (const filePath of this.fileCache.keys()) {
      if (!seen.has(filePath)) this.fileCache.delete(filePath);
    }
  }
}

/** @typedef {{filePath:string, parse:() => Promise<Object[]>}} Target */

/** @returns {Promise<Target[]>} */
async function claudeFiles(root) {
  if (!root) return [];
  const files = await walk(root, (name) => name.endsWith(".jsonl"));
  return files.map((filePath) => ({ filePath, parse: () => parseClaudeFile(filePath) }));
}

/** @returns {Promise<Target[]>} */
async function codexFiles(root) {
  if (!root) return [];
  const files = await walk(root, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
  return files.map((filePath) => ({ filePath, parse: () => parseCodexFile(filePath) }));
}

/**
 * `<tmpRoot>/<slug>/chats/session-*.json`, with cwd from the sibling
 * `.project_root` file gemini-cli writes beside `chats/` (the chat file
 * itself carries no cwd — only a sha256 projectHash). Two shallow readdirs
 * rather than a recursive walk: `<tmpRoot>/<slug>/` also holds bulky caches.
 * @returns {Promise<Target[]>}
 */
async function geminiFiles(root) {
  if (!root) return [];
  let slugs;
  try {
    slugs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const projectDir = path.join(root, slug.name);
    let names;
    try {
      names = await readdir(path.join(projectDir, "chats"));
    } catch {
      continue; // no chats/ yet
    }
    const cwd = await projectRoot(projectDir);
    for (const name of names) {
      if (!name.startsWith("session-") || !name.endsWith(".json")) continue;
      const filePath = path.join(projectDir, "chats", name);
      out.push({ filePath, parse: () => parseGeminiFile(filePath, cwd) });
    }
  }
  return out;
}

async function projectRoot(projectDir) {
  try {
    return (await readFile(path.join(projectDir, ".project_root"), "utf8")).trim() || null;
  } catch {
    return null; // cwd unknown → deriveRepo() yields "other"
  }
}

/** Recursive file listing, absolute paths, filtered by basename. */
async function walk(root, match) {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return []; // root absent — serve whatever is cached
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !match(entry.name)) continue;
    out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

/**
 * GET /costs?window=24h|7d|30d (default 24h) — same extraHttp contract as
 * the chat/approval handlers: returns true when the request was handled.
 * @param {UsageCostIndex} index
 */
export function createCostsHttpHandler(index) {
  return (req, res, url) => {
    if (req.method !== "GET" || url.pathname !== "/costs") return false;
    const window = url.searchParams.get("window") ?? "24h";
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
    if (!WINDOWS_MS[window]) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: `window must be one of ${Object.keys(WINDOWS_MS).join("|")}` }));
      return true;
    }
    index
      .query(window)
      .then((body) => {
        res.writeHead(200, headers);
        res.end(JSON.stringify(body));
      })
      .catch((error) => {
        console.error("[costs] aggregation failed:", error);
        res.writeHead(500, headers);
        res.end(JSON.stringify({ error: "cost aggregation failed" }));
      });
    return true;
  };
}

function emptyRow() {
  return { usd: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function mapRow(map, key, extra) {
  let row = map.get(key);
  if (!row) {
    row = { ...extra, ...emptyRow() };
    map.set(key, row);
  }
  return row;
}

function addRow(row, b) {
  row.usd += b.usd;
  row.tokens += b.tokens;
  row.input += b.input;
  row.output += b.output;
  row.cacheWrite += b.cacheWrite;
  row.cacheRead += b.cacheRead;
}

function roundRow(row) {
  return { ...row, usd: round(row.usd) };
}

function round(usd) {
  return Math.round(usd * 10000) / 10000;
}

/** Local-time YYYY-MM-DD for an hour-bucket start (user is UTC+7 — UTC days would split his mornings). */
function dayOf(hourMs) {
  const d = new Date(hourMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
