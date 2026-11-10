// `ao doctor`: can each adapter still read what this machine's agents write today?
// For every harness that left transcripts here, take the newest one, run its LAST lines
// through the real normalizer and see whether events come out. Read-only: files are opened
// for reading, nothing is created, nothing is executed (no `<cli> --version`: some CLIs
// register the cwd in their own config when started). The version shown is the one the
// transcript itself records, i.e. the version the adapter was actually checked against.
//
// Results: {id: "adapter-<harness>", status: ok|warn|info, title, detail}.
// A harness with no transcripts on this machine produces no line (doctor already says
// whether its CLI is installed).

import fs from "node:fs";
import path from "node:path";
import { SessionNormalizer } from "../normalize.js";
import { CodexSessionNormalizer } from "../codex-normalize.js";
import { GeminiSessionNormalizer } from "../gemini-normalize.js";
import { HermesSessionNormalizer } from "../hermes-normalize.js";
import { resolveClaudeRoots } from "../worker-lanes.js";

const TAIL_BYTES = 512 * 1024;
const TAIL_LINES = 300;
const MAX_JSON_BYTES = 20 * 1024 * 1024;

/** Files under root (to maxDepth directory levels) whose name passes `test`, newest first. */
function listFiles(root, test, maxDepth) {
  const out = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (level < maxDepth) walk(p, level + 1);
      } else if (test(e.name)) {
        try {
          out.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readSlice(file, from, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Parsed JSON lines from the end of a JSONL file (a torn or partial line is dropped). */
function tailJsonl(file) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - TAIL_BYTES);
  let lines = readSlice(file, start, Math.min(size, TAIL_BYTES)).split("\n");
  if (start > 0) lines = lines.slice(1);
  const parsed = [];
  for (const l of lines.slice(-TAIL_LINES)) {
    if (!l) continue;
    try {
      parsed.push(JSON.parse(l));
    } catch {
      // torn line
    }
  }
  return parsed;
}

const firstJsonLine = (file) => {
  try {
    return JSON.parse(readSlice(file, 0, 256 * 1024).split("\n")[0]);
  } catch {
    return null;
  }
};

function age(ms, now) {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const entry = (id, status, title, detail) => ({ id: `adapter-${id}`, status, title, ...(detail ? { detail } : {}) });
const readable = (id, events, extra) => entry(id, "ok", `adapter ${id} reads its transcripts`, `${events} events from the newest file${extra}`);
const unreadable = (id, why) =>
  entry(id, "warn", `adapter ${id}: the newest transcript does not parse into events`, `${why}; the format may have changed`);

function checkClaude({ id, root, harness, now }) {
  const files = listFiles(root, (n) => n.endsWith(".jsonl"), 1);
  if (files.length === 0) return null;
  const { file, mtimeMs } = files[0];
  const lines = tailJsonl(file);
  const normalizer = new SessionNormalizer("adapter-check", { harness });
  let events = 0;
  let version = null;
  for (const raw of lines) {
    if (typeof raw?.version === "string") version = raw.version;
    try {
      events += normalizer.normalizeLine(raw).length;
    } catch {
      // a line the normalizer chokes on counts as no events
    }
  }
  const extra = ` (written by Claude Code ${version ?? "unknown version"}, ${age(mtimeMs, now)})`;
  return events > 0 ? readable(id, events, extra) : unreadable(id, `${lines.length} lines read${extra}`);
}

function checkCodex({ root, now }) {
  const all = listFiles(root, (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n), 3);
  if (all.length === 0) return null;
  const plain = all.filter((f) => f.file.endsWith(".jsonl"));
  const zst = all.filter((f) => f.file.endsWith(".zst"));
  const zstNote = zst.length
    ? `${zst.length} rollout files are .jsonl.zst (newest ${age(zst[0].mtimeMs, now)}); the tailer reads only plain .jsonl`
    : "";
  if (plain.length === 0) return entry("codex", "warn", "adapter codex: every rollout on this machine is compressed (.jsonl.zst)", zstNote);
  const { file, mtimeMs } = plain[0];
  const normalizer = new CodexSessionNormalizer("adapter-check");
  const head = firstJsonLine(file);
  let events = head ? normalizer.normalizeLine(head).length : 0;
  for (const raw of tailJsonl(file)) {
    try {
      events += normalizer.normalizeLine(raw).length;
    } catch {
      // counts as no events
    }
  }
  const extra = ` (codex ${head?.payload?.cli_version ?? "unknown version"}, ${age(mtimeMs, now)})`;
  if (events === 0) return unreadable("codex", `newest plain rollout${extra}`);
  const ok = readable("codex", events, extra);
  // a newer compressed rollout than the newest plain one means recent sessions are invisible to the tailer
  return zst.length && zst[0].mtimeMs > mtimeMs ? { ...ok, status: "warn", detail: `${ok.detail}. ${zstNote}` } : ok;
}

function checkGemini({ root, now }) {
  const files = listFiles(root, (n) => /^session-.*\.json$/.test(n), 2);
  if (files.length === 0) return null;
  const { file, mtimeMs } = files[0];
  let doc;
  try {
    if (fs.statSync(file).size > MAX_JSON_BYTES) return entry("gemini", "info", "adapter gemini: newest session file is too large to check");
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return unreadable("gemini", "the newest chat file is not valid JSON");
  }
  const normalizer = new GeminiSessionNormalizer(doc?.sessionId ?? "adapter-check");
  let events = 0;
  for (const m of Array.isArray(doc?.messages) ? doc.messages : []) {
    try {
      events += normalizer.normalizeMessage(m, { cwd: "/adapter-check" }).length;
    } catch {
      // counts as no events
    }
  }
  const extra = ` (${age(mtimeMs, now)})`;
  return events > 0 ? readable("gemini", events, extra) : unreadable("gemini", `no messages produced events${extra}`);
}

async function checkHermes({ dbPath, now }) {
  if (!fs.existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return entry("hermes", "info", "adapter hermes: cannot be checked on this Node (node:sqlite needs Node 22.13 or newer)");
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare("SELECT id, session_id, role, content, tool_calls, tool_name, tool_call_id, timestamp FROM messages ORDER BY id DESC LIMIT 200")
      .all()
      .reverse();
    if (rows.length === 0) return null;
    const normalizers = new Map();
    const sessions = new Map();
    let events = 0;
    for (const r of rows) {
      if (!sessions.has(r.session_id)) {
        sessions.set(
          r.session_id,
          db.prepare("SELECT id, source, model, cwd, git_repo_root, started_at FROM sessions WHERE id = ?").get(r.session_id) ?? { id: r.session_id },
        );
        normalizers.set(r.session_id, new HermesSessionNormalizer(r.session_id));
      }
      let toolCalls = [];
      try {
        const parsed = JSON.parse(r.tool_calls ?? "[]");
        if (Array.isArray(parsed)) toolCalls = parsed.filter((c) => c && typeof c === "object");
      } catch {
        // torn tool_calls: that row only loses its tool events
      }
      events += normalizers.get(r.session_id).normalizeMessage(
        { id: r.id, role: r.role, content: typeof r.content === "string" ? r.content : null, toolCalls, toolName: r.tool_name, toolCallId: r.tool_call_id, ts: Math.round(r.timestamp * 1000) },
        { ...sessions.get(r.session_id) },
      ).length;
    }
    const extra = ` (newest message ${age(rows.at(-1).timestamp * 1000, now)})`;
    return events > 0 ? readable("hermes", events, extra) : unreadable("hermes", `${rows.length} messages read${extra}`);
  } catch (error) {
    return entry("hermes", "warn", "adapter hermes: state.db could not be read", `${error.message}; the schema may have changed`);
  } finally {
    db?.close();
  }
}

/**
 * @param {{homeDir: string, env?: Record<string,string>, now?: () => number}} o
 * @returns {Promise<{id: string, status: string, title: string, detail?: string}[]>}
 */
export async function checkAdapters({ homeDir, env = {}, now = Date.now }) {
  const t = now();
  const out = [];
  for (const { root, harness } of resolveClaudeRoots({ env, homeDir })) {
    const r = checkClaude({ id: harness, root, harness, now: t });
    if (r) out.push(r);
  }
  for (const r of [
    checkCodex({ root: path.join(homeDir, ".codex", "sessions"), now: t }),
    checkGemini({ root: path.join(homeDir, ".gemini", "tmp"), now: t }),
    await checkHermes({ dbPath: path.join(homeDir, ".hermes", "state.db"), now: t }),
  ]) {
    if (r) out.push(r);
  }
  return out;
}
