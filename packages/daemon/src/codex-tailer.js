// Tails OpenAI Codex CLI rollout JSONL files under ~/.codex/sessions/ and
// emits parsed lines as they're written — the Codex counterpart of
// tailer.js (same polling rationale; see the module comment there).
//
// Layout (verified against 245 real rollout files on this machine,
// codex-cli 0.142.x): `<root>/<yyyy>/<mm>/<dd>/rollout-<iso-ts>-<uuid>.jsonl`.
// One file per session (thread); sub-agent threads get their OWN rollout
// file whose first `session_meta` line carries the parent thread id — so
// unlike Claude Code there is no separate subagents/ directory to walk,
// and parent resolution happens in codex-normalize.js, not here.

import { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 1000;
// Skip history for rollout files idle longer than this on first sight: a
// session inactive past the session-end timeout would only backfill into
// characters that immediately session_end (and one historical file here is
// 96MB). Safe to skip because Codex re-appends a fresh session_meta line on
// every resume (observed ~9 per file), so a session that wakes up still
// opens with a clean session_start.
const DEFAULT_BACKFILL_MAX_AGE_MS = 5 * 60 * 1000;

// rollout-2026-07-05T21-14-23-019f32a1-5afa-7b60-9a40-02a7ff1dc28e.jsonl
const ROLLOUT_FILE_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/**
 * @fires CodexTailer#line  ({filePath, sessionId, line: object})
 * @fires CodexTailer#error ({filePath, error})
 */
export class CodexTailer extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.sessionsRoot absolute path to ~/.codex/sessions
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.backfillMaxAgeMs] files idle longer than this when
   *   first seen start tailing at EOF instead of replaying their history
   */
  constructor({
    sessionsRoot,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    backfillMaxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS,
  }) {
    super();
    this.sessionsRoot = sessionsRoot;
    this.pollIntervalMs = pollIntervalMs;
    this.backfillMaxAgeMs = backfillMaxAgeMs;
    /** @type {Map<string, number>} filePath -> bytes already read */
    this.offsets = new Map();
    this._timer = null;
    this._ticking = false;
  }

  start() {
    if (this._timer) return;
    this._tick();
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    // Never overlap ticks — see tailer.js: a tick slower than the poll
    // interval otherwise stacks concurrent full re-reads of un-offset files.
    if (this._ticking) return;
    this._ticking = true;
    try {
      let files;
      try {
        files = await findRolloutFiles(this.sessionsRoot);
      } catch (error) {
        this.emit("error", { filePath: this.sessionsRoot, error });
        return;
      }

      for (const { filePath, sessionId } of files) {
        try {
          await this._readNewBytes(filePath, sessionId);
        } catch (error) {
          this.emit("error", { filePath, error });
        }
      }
    } finally {
      this._ticking = false;
    }
  }

  async _readNewBytes(filePath, sessionId) {
    const stats = await stat(filePath);

    if (!this.offsets.has(filePath) && Date.now() - stats.mtimeMs > this.backfillMaxAgeMs) {
      // First sight of a long-idle file: skip its history, tail from here.
      this.offsets.set(filePath, stats.size);
      return;
    }
    const previousOffset = this.offsets.get(filePath) ?? 0;

    if (stats.size < previousOffset) {
      this.offsets.set(filePath, 0);
      return this._readNewBytes(filePath, sessionId);
    }
    if (stats.size === previousOffset) return;

    const chunk = await readRange(filePath, previousOffset, stats.size);
    this.offsets.set(filePath, stats.size);

    for (const rawLine of chunk.split("\n")) {
      if (!rawLine.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        continue; // partial/corrupt line — skip rather than crash the tailer
      }
      this.emit("line", { filePath, sessionId, line: parsed });
    }
  }
}

/**
 * Find rollout files under `<root>/<yyyy>/<mm>/<dd>/`. The recursive readdir
 * is cheap: the tree is only 3 directory levels deep and each leaf holds a
 * handful of files.
 * @param {string} root
 * @returns {Promise<Array<{filePath: string, sessionId: string}>>}
 */
async function findRolloutFiles(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = ROLLOUT_FILE_RE.exec(entry.name);
    if (!match) continue;
    results.push({
      filePath: path.join(entry.parentPath ?? entry.path, entry.name),
      sessionId: match[1],
    });
  }
  return results;
}

/**
 * Read bytes [start, end) from a file as utf8 text.
 * (Same helper as tailer.js keeps private — duplicated rather than exported
 * to leave the Claude Code source files untouched.)
 */
function readRange(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, { start, end: end - 1 });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}
