// Tails Hermes Agent (Nous Research) sessions. Unlike the Claude/Codex JSONL
// transcripts, Hermes keeps its LIVE sessions in a SQLite database
// (~/.hermes/state.db, WAL mode: tables `sessions` and `messages`); the JSONL
// files under ~/.hermes/sessions/ are a legacy format the current version no
// longer writes. See docs/hermes-adapter.md.
//
// We open the database read-only with node's built-in SQLite (node:sqlite,
// Node >= 22.13) so the daemon keeps its single dependency. On an older Node
// the tailer emits "unavailable" once and goes quiet; everything else in the
// daemon is unaffected. Polling (like the other tailers) because WAL commits
// raise no watchable event on the main file.
//
// Why a fresh connection per tick: a long-lived read connection pins a WAL
// snapshot and blocks Hermes' checkpoints. Open, read, close.
//
// Privacy: only the columns the normalizer needs are selected — never
// system_prompt, model_config, origin_json or other session metadata.

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

const DEFAULT_POLL_INTERVAL_MS = 2000;
// Same cutoff as the other tailers: history older than this on first sight is
// skipped (the character would immediately time out anyway).
const DEFAULT_BACKFILL_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * @fires HermesTailer#message     ({sessionId, session, message})
 * @fires HermesTailer#error       ({filePath, error})
 * @fires HermesTailer#unavailable ({reason}) node:sqlite missing — emitted once
 */
export class HermesTailer extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.dbPath absolute path to ~/.hermes/state.db
   */
  constructor({ dbPath, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, backfillMaxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS }) {
    super();
    this.dbPath = dbPath;
    this.pollIntervalMs = pollIntervalMs;
    // a non-numeric env override must not turn the cutoff into NaN (which matches no row)
    this.backfillMaxAgeMs = Number.isFinite(backfillMaxAgeMs) ? backfillMaxAgeMs : DEFAULT_BACKFILL_MAX_AGE_MS;
    /** @type {number|null} highest message id already handled; null until first sight */
    this.lastId = null;
    this._timer = null;
    this._ticking = false;
    this._sqlite = undefined; // undefined = not tried, null = unavailable
    this._lastError = null;
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

  async _loadSqlite() {
    if (this._sqlite !== undefined) return this._sqlite;
    try {
      this._sqlite = (await import("node:sqlite")).DatabaseSync;
    } catch {
      this._sqlite = null;
      this.emit("unavailable", { reason: "node:sqlite needs Node >= 22.13" });
      this.stop();
    }
    return this._sqlite;
  }

  async _tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      if (!existsSync(this.dbPath)) return; // Hermes not installed (yet)
      const DatabaseSync = await this._loadSqlite();
      if (!DatabaseSync) return;
      const db = new DatabaseSync(this.dbPath, { readOnly: true });
      try {
        this._readNew(db);
      } finally {
        db.close();
      }
      this._lastError = null; // recovered: the same fault later is news again
    } catch (error) {
      // a persistent problem (schema drift, locked file) must not log every 2s
      if (error.message !== this._lastError) this.emit("error", { filePath: this.dbPath, error });
      this._lastError = error.message;
    } finally {
      this._ticking = false;
    }
  }

  _readNew(db) {
    let rows;
    if (this.lastId === null) {
      // first sight: remember where history ends, replay only the recent tail
      this.lastId = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages").get().m;
      const cutoffS = (Date.now() - this.backfillMaxAgeMs) / 1000;
      rows = db.prepare(`${SELECT_MESSAGES} WHERE timestamp >= ? AND id <= ? ORDER BY id`).all(cutoffS, this.lastId);
    } else {
      rows = db.prepare(`${SELECT_MESSAGES} WHERE id > ? ORDER BY id`).all(this.lastId);
    }
    if (rows.length === 0) return;

    const sessions = new Map();
    for (const row of rows) {
      // advance per row and isolate each one: a listener that throws on a
      // malformed row must cost that row only, never the rest of the batch
      this.lastId = Math.max(this.lastId, row.id);
      try {
        this._emitRow(db, sessions, row);
      } catch (error) {
        this.emit("error", { filePath: `${this.dbPath} (message ${row.id})`, error });
      }
    }
  }

  _emitRow(db, sessions, row) {
    let session = sessions.get(row.session_id);
    if (!session) {
      session =
        db
          .prepare("SELECT id, source, model, cwd, git_repo_root, started_at FROM sessions WHERE id = ?")
          .get(row.session_id) ?? { id: row.session_id };
      sessions.set(row.session_id, session);
    }
    this.emit("message", { sessionId: row.session_id, session: { ...session }, message: toMessage(row) });
  }
}

const SELECT_MESSAGES =
  "SELECT id, session_id, role, content, tool_calls, tool_name, tool_call_id, timestamp FROM messages";

function toMessage(row) {
  let toolCalls = [];
  if (row.tool_calls) {
    try {
      const parsed = JSON.parse(row.tool_calls);
      if (Array.isArray(parsed)) toolCalls = parsed.filter((c) => c && typeof c === "object");
    } catch {
      // a torn tool_calls value just loses its tool events
    }
  }
  return {
    id: row.id,
    role: row.role,
    content: typeof row.content === "string" ? row.content : null, // BLOB/odd types: no text
    toolCalls,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    ts: Math.round(row.timestamp * 1000),
  };
}
