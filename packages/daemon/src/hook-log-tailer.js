// Tails the fixed-path hook event log written by
// packages/daemon/hooks/notify.mjs (a PreToolUse/PostToolUse Claude Code
// hook, PROPOSED but not yet registered — see
// docs/pretooluse-hook-proposal.md). Same polling design as tailer.js
// (TranscriptTailer) and for the same reason: fs.watch is unreliable for
// pure-append writes across platforms, so a byte-offset poll is simpler and
// portable.
//
// This is a SEPARATE, single-file tailer rather than a generalization of
// TranscriptTailer (which watches a whole directory tree of per-session
// files) because the hook log is one shared flat file written by every
// Claude Code session on the machine — a fundamentally different shape.
// Keeping them as two small focused files (per this repo's file-size
// convention) is simpler than bolting a "single file" mode onto the
// directory-scanning tailer.

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 250; // faster than transcript tailer (1s):
// this log exists specifically to shave latency off the "waiting for
// approval" signal, so it should poll tighter than the transcript tailer.
// 250ms keeps CPU cost negligible (one stat() on a small file) while still
// being well under human-perceptible delay for a UI status dot.

export const DEFAULT_HOOK_LOG_PATH = path.join(
  os.homedir(),
  ".claude",
  "agent-office-hook-events.jsonl"
);

/**
 * @fires HookLogTailer#line  ({line: object})
 * @fires HookLogTailer#error ({error})
 */
export class HookLogTailer extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.logPath] absolute path to the hook event log
   * @param {number} [opts.pollIntervalMs]
   * @param {boolean} [opts.startAtEnd] skip everything already in the file
   *   on the first tick and only emit lines appended after start(). The
   *   hook log is a machine-wide append-only file that can hold hours of
   *   history; this signal is only useful live, and replaying it would
   *   flood the WS server's small recent-events backlog on boot.
   */
  constructor({
    logPath = DEFAULT_HOOK_LOG_PATH,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    startAtEnd = false,
  } = {}) {
    super();
    this.logPath = logPath;
    this.pollIntervalMs = pollIntervalMs;
    this.startAtEnd = startAtEnd;
    this.offset = 0;
    this._skippedToEnd = false;
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
    // Never overlap ticks — see tailer.js. 250ms interval + one slow disk
    // stat is all it takes to start stacking.
    if (this._ticking) return;
    this._ticking = true;
    try {
      if (!existsSync(this.logPath)) return; // hook not registered yet, or nothing logged yet

      const stats = await stat(this.logPath);
      if (this.startAtEnd && !this._skippedToEnd) {
        this._skippedToEnd = true;
        this.offset = stats.size;
        return;
      }
      if (stats.size < this.offset) {
        // File was truncated/rotated externally — restart from the top.
        this.offset = 0;
      }
      if (stats.size === this.offset) return; // nothing new

      const chunk = await readRange(this.logPath, this.offset, stats.size);
      this.offset = stats.size;

      const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
      for (const rawLine of lines) {
        let parsed;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue; // partial write from a concurrent session — skip, don't crash
        }
        this.emit("line", { line: parsed });
      }
    } catch (error) {
      this.emit("error", { error });
    } finally {
      this._ticking = false;
    }
  }
}

/**
 * @param {string} filePath
 * @param {number} start
 * @param {number} end
 * @returns {Promise<string>}
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
