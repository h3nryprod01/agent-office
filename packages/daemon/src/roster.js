// Hiring Hall (wi-hiring-hall): serve the company roster over HTTP and
// broadcast a `roster_updated` event (ADDITIVE v1 type) when the file changes.
//
// Source of truth: ~/.claude/company/roster.yaml (written by the user-level
// skills company-roster / company-hire). The daemon only READS it — hiring
// itself goes through the PM + company-hire skill, never through here.
//
// ponytail: parseRoster is a minimal YAML-subset parser, NOT general YAML —
// it covers exactly what the roster schema uses (nested maps by indent,
// `- ` list items as inline `{...}` or block maps, inline `[...]` arrays,
// quoted strings that may contain `:` `#` `,`, and `#` comments). No
// anchors, no multiline scalars, no nested flow collections. If the schema
// ever outgrows this, swap in js-yaml and delete parseRoster.

import { watch, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ROSTER_PATH = path.join(os.homedir(), ".claude", "company", "roster.yaml");

export const EMPTY_ROSTER = Object.freeze({ version: null, updated: null, departments: [] });

/** Cut a trailing `# comment` (only when the # starts the line or follows whitespace, outside quotes). */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split on `sep` chars at flow depth 0 (outside quotes and {}/[]). */
function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
    } else if (ch === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** First `:` outside quotes that ends a key — `null` key when the line isn't a pair. */
function splitKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
      return { key: unquote(text.slice(0, i).trim()), rest: text.slice(i + 1).trim() };
    }
  }
  return { key: null, rest: "" };
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s) {
  if (s.startsWith("{")) return parseInlineMap(s);
  if (s.startsWith("[")) return parseInlineArray(s);
  const raw = unquote(s);
  if (raw === s) {
    // unquoted only: numbers/bools become typed, dates stay strings
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null" || raw === "~" || raw === "") return null;
  }
  return raw;
}

function parseInlineMap(s) {
  const inner = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  const obj = {};
  for (const part of splitTop(inner, ",")) {
    const { key, rest } = splitKey(part.trim());
    if (key !== null) obj[key] = parseScalar(rest);
  }
  return obj;
}

function parseInlineArray(s) {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return splitTop(inner, ",").map((part) => parseScalar(part.trim()));
}

/** @returns {[unknown, number]} parsed block value + index of the first line after it */
function parseBlock(lines, i) {
  return lines[i].text.startsWith("- ") ? parseList(lines, i) : parseMap(lines, i);
}

function parseMap(lines, i) {
  const indent = lines[i].indent;
  const obj = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
    const { key, rest } = splitKey(lines[i].text);
    if (key === null) {
      i++; // not a `key: value` line — tolerate and move on, never crash
      continue;
    }
    if (rest !== "") {
      obj[key] = parseScalar(rest);
      i++;
    } else if (lines[i + 1] && lines[i + 1].indent > indent) {
      const [value, next] = parseBlock(lines, i + 1);
      obj[key] = value;
      i = next;
    } else {
      obj[key] = null;
      i++;
    }
  }
  return [obj, i];
}

function parseList(lines, i) {
  const indent = lines[i].indent;
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
    const rest = lines[i].text.slice(2).trim();
    if (rest.startsWith("{") || rest.startsWith("[")) {
      arr.push(parseScalar(rest));
      i++;
      continue;
    }
    // block map item: first pair on the `- ` line, more pairs on deeper lines
    const item = {};
    const first = splitKey(rest);
    if (first.key !== null) item[first.key] = first.rest !== "" ? parseScalar(first.rest) : null;
    i++;
    while (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith("- ")) {
      const { key, rest: value } = splitKey(lines[i].text);
      if (key !== null) item[key] = value !== "" ? parseScalar(value) : null;
      i++;
    }
    arr.push(item);
  }
  return [arr, i];
}

/**
 * Parse roster.yaml text into the normalized shape served by GET /roster:
 * `{ version, updated, departments: [{ name, budgetUsdPerDay, members }] }`,
 * members = `{ name, role, hired, source, cv }` (missing fields → null).
 * Field-tolerant by contract (company-roster SKILL.md: readers must survive
 * odd/missing fields); throws only on input it can't line-parse at all.
 */
export function parseRoster(text) {
  const lines = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const cut = stripComment(raw);
    if (cut.trim() === "") continue;
    lines.push({ indent: cut.length - cut.trimStart().length, text: cut.trim() });
  }
  if (lines.length === 0) return { ...EMPTY_ROSTER };
  const [doc] = parseBlock(lines, 0);
  return normalizeRoster(doc);
}

function normalizeRoster(doc) {
  const departments = [];
  const depts = doc && typeof doc === "object" ? doc.departments : null;
  if (depts && typeof depts === "object" && !Array.isArray(depts)) {
    for (const [name, dept] of Object.entries(depts)) {
      const d = dept && typeof dept === "object" ? dept : {};
      const members = Array.isArray(d.members)
        ? d.members
            .filter((m) => m && typeof m === "object" && m.name != null)
            .map((m) => ({
              name: String(m.name),
              role: m.role != null ? String(m.role) : null,
              hired: m.hired != null ? String(m.hired) : null,
              source: m.source != null ? String(m.source) : null,
              cv: m.cv && typeof m.cv === "object" ? m.cv : null,
            }))
        : [];
      departments.push({
        name,
        budgetUsdPerDay: typeof d.budget_usd_per_day === "number" ? d.budget_usd_per_day : null,
        members,
      });
    }
  }
  return {
    version: typeof doc?.version === "number" ? doc.version : null,
    updated: doc?.updated != null ? String(doc.updated) : null,
    departments,
  };
}

/** Read + parse the roster file; missing/corrupt degrades to EMPTY_ROSTER, never throws. */
export function readRoster(rosterPath) {
  try {
    return parseRoster(readFileSync(rosterPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[roster] unreadable (${error.message}): ${rosterPath}`);
    }
    return { ...EMPTY_ROSTER };
  }
}

/** GET /roster — read from disk per request (tiny file, same discipline as /work-items). */
export function createRosterHttpHandler({ rosterPath = DEFAULT_ROSTER_PATH } = {}) {
  return (req, res, url) => {
    if (req.method !== "GET" || url.pathname !== "/roster") return false;
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(readRoster(rosterPath)));
    return true;
  };
}

/**
 * Watch roster.yaml and call `onRoster(roster)` when its CONTENT changes.
 * Watches the parent directory (editors save via atomic rename, which kills
 * a file-level watcher) and debounces the burst of events per save.
 */
export class RosterWatcher {
  constructor({ rosterPath = DEFAULT_ROSTER_PATH, onRoster, debounceMs = 300 }) {
    this.rosterPath = rosterPath;
    this.onRoster = onRoster;
    this.debounceMs = debounceMs;
    this.watcher = null;
    this.timer = null;
    this.lastSig = null;
  }

  start() {
    this.lastSig = JSON.stringify(readRoster(this.rosterPath)); // baseline, no event
    const dir = path.dirname(this.rosterPath);
    const base = path.basename(this.rosterPath);
    try {
      this.watcher = watch(dir, (eventType, filename) => {
        if (filename && filename !== base) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.#emitIfChanged(), this.debounceMs);
      });
      this.watcher.on("error", (error) => {
        console.warn(`[roster] watcher error: ${error.message}`);
      });
    } catch (error) {
      // ponytail: no retry — company dir missing means the roster feature is
      // simply off until the daemon restarts after the dir exists.
      console.warn(`[roster] not watching (${error.message}): ${dir}`);
    }
  }

  #emitIfChanged() {
    this.timer = null;
    const roster = readRoster(this.rosterPath);
    const sig = JSON.stringify(roster);
    if (sig === this.lastSig) return; // touch/duplicate fs events — no change
    this.lastSig = sig;
    this.onRoster(roster);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
