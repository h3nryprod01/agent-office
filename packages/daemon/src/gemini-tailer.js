// Tails Gemini CLI chat session files under ~/.gemini/tmp/ and emits each
// newly-written message — the Gemini counterpart of codex-tailer.js.
//
// Layout (verified against gemini-cli 0.29.5 on this machine):
//   ~/.gemini/tmp/<slug>/chats/session-<iso-ts>-<short-id>.json
//   ~/.gemini/tmp/<slug>/.project_root   <- absolute cwd of that session's project
//
// The big difference from Claude Code and Codex: a Gemini chat file is NOT
// append-only JSONL. It is one JSON document (`{sessionId, messages: [...]}`)
// that gemini-cli rewrites in place after every message — so byte offsets are
// meaningless and we re-parse the whole document whenever mtime changes.
// Writes are incremental during a live session (observed: a file appearing
// with 1 message and growing to 3 as the turn ran), so tailing is real-time.
//
// Two mutations are possible, both handled below:
//   - messages[] grows (recordMessage always pushes a fully-formed message —
//     text never streams in, so a message is final on first write); and
//   - the LAST message's toolCalls[] grows, because recordToolCalls() appends
//     into the trailing `gemini` message rather than creating a new one.
// So per file we remember (messages emitted, toolCalls emitted in the last
// message) — the O(1) analogue of the Codex tailer's byte offset. `rewindTo`
// and `deleteSession` can shrink messages[]; that resets the counters.
//
// ponytail: whole-file re-parse per change. Real session files here are a few
// KB; if one ever grows to tens of MB, switch to a streaming/incremental
// parse keyed off `lastUpdated`.

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 1000;
// Same rationale as codex-tailer.js: a session idle past the inactivity
// timeout would only backfill into a character that immediately session_ends.
const DEFAULT_BACKFILL_MAX_AGE_MS = 5 * 60 * 1000;

const SESSION_FILE_RE = /^session-.*\.json$/;

function toolCallCount(message) {
  return Array.isArray(message?.toolCalls) ? message.toolCalls.length : 0;
}

/**
 * @fires GeminiTailer#message ({filePath, sessionId, cwd, message, toolCallOffset})
 * @fires GeminiTailer#error   ({filePath, error})
 */
export class GeminiTailer extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.tmpRoot absolute path to ~/.gemini/tmp
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.backfillMaxAgeMs] files idle longer than this when
   *   first seen are adopted at their current end instead of replayed
   */
  constructor({
    tmpRoot,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    backfillMaxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS,
  }) {
    super();
    this.tmpRoot = tmpRoot;
    this.pollIntervalMs = pollIntervalMs;
    this.backfillMaxAgeMs = backfillMaxAgeMs;
    /** @type {Map<string, {mtimeMs: number, messages: number, lastToolCalls: number}>} */
    this.state = new Map();
    /** @type {Map<string, string|null>} project dir -> cwd from .project_root */
    this.projectRoots = new Map();
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
    if (this._ticking) return; // never overlap ticks — see tailer.js
    this._ticking = true;
    try {
      let files;
      try {
        files = await findSessionFiles(this.tmpRoot);
      } catch (error) {
        this.emit("error", { filePath: this.tmpRoot, error });
        return;
      }
      for (const file of files) {
        try {
          await this._readFile(file);
        } catch (error) {
          this.emit("error", { filePath: file.filePath, error });
        }
      }
    } finally {
      this._ticking = false;
    }
  }

  /** @private @param {{filePath: string, projectDir: string}} file */
  async _readFile({ filePath, projectDir }) {
    const stats = await stat(filePath);
    let state = this.state.get(filePath);

    if (!state) {
      const idle = Date.now() - stats.mtimeMs > this.backfillMaxAgeMs;
      state = { mtimeMs: 0, messages: 0, lastToolCalls: 0 };
      this.state.set(filePath, state);
      if (idle) {
        // First sight of a long-idle file: adopt its contents without emitting.
        const doc = await this._readDoc(filePath);
        if (doc) {
          state.mtimeMs = stats.mtimeMs;
          state.messages = doc.messages.length;
          state.lastToolCalls = toolCallCount(doc.messages[doc.messages.length - 1]);
        }
        return;
      }
    }

    if (stats.mtimeMs === state.mtimeMs) return;

    const doc = await this._readDoc(filePath);
    // A torn read of a half-rewritten file: leave mtimeMs untouched so the
    // next tick retries rather than skipping the messages we failed to parse.
    if (!doc) return;

    const { sessionId, messages } = doc;
    const cwd = await this._projectRoot(projectDir);

    if (messages.length < state.messages) {
      // /chat rewind or delete truncated the document — replay from the top.
      // Event ids are content-derived and stable, so a renderer dedups these.
      state.messages = 0;
      state.lastToolCalls = 0;
    }

    // 1) tool calls appended to the trailing message we already forwarded
    if (state.messages > 0) {
      const last = messages[state.messages - 1];
      if (toolCallCount(last) > state.lastToolCalls) {
        this.emit("message", {
          filePath,
          sessionId,
          cwd,
          message: last,
          toolCallOffset: state.lastToolCalls,
        });
      }
    }

    // 2) messages written since the last tick
    for (let i = state.messages; i < messages.length; i += 1) {
      this.emit("message", {
        filePath,
        sessionId,
        cwd,
        message: messages[i],
        toolCallOffset: 0,
      });
    }

    state.messages = messages.length;
    state.lastToolCalls = toolCallCount(messages[messages.length - 1]);
    state.mtimeMs = stats.mtimeMs;
  }

  /**
   * @private
   * @returns {Promise<{sessionId: string, messages: Object[]}|null>} null when the
   *   file is unparseable (mid-rewrite) or lacks the fields we depend on
   */
  async _readDoc(filePath) {
    let doc;
    try {
      doc = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      return null;
    }
    if (typeof doc?.sessionId !== "string" || !Array.isArray(doc.messages)) return null;
    return { sessionId: doc.sessionId, messages: doc.messages };
  }

  /**
   * cwd for a session, from the `.project_root` file gemini-cli writes beside
   * the chats/ directory. Read once per project dir.
   * @private
   */
  async _projectRoot(projectDir) {
    if (this.projectRoots.has(projectDir)) return this.projectRoots.get(projectDir);
    let root = null;
    try {
      root = (await readFile(path.join(projectDir, ".project_root"), "utf8")).trim() || null;
    } catch {
      root = null; // no .project_root -> cwd unknown -> deriveRepo() yields "other"
    }
    this.projectRoots.set(projectDir, root);
    return root;
  }
}

/**
 * Find `<tmpRoot>/<slug>/chats/session-*.json`. Two shallow readdirs rather
 * than a recursive walk: ~/.gemini/tmp also holds unrelated per-project scratch
 * (a vendored `rg` binary, caches) we have no business descending into.
 * @param {string} tmpRoot
 * @returns {Promise<Array<{filePath: string, projectDir: string}>>}
 */
async function findSessionFiles(tmpRoot) {
  if (!existsSync(tmpRoot)) return [];
  const results = [];
  for (const slug of await readdir(tmpRoot, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const projectDir = path.join(tmpRoot, slug.name);
    const chatsDir = path.join(projectDir, "chats");
    if (!existsSync(chatsDir)) continue;
    for (const entry of await readdir(chatsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !SESSION_FILE_RE.test(entry.name)) continue;
      results.push({ filePath: path.join(chatsDir, entry.name), projectDir });
    }
  }
  return results;
}
