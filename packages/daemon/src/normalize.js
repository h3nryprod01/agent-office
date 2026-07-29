// Turns one raw Claude Code transcript JSONL line into zero or more
// normalized events (see event-schema.js).
//
// Raw transcript line shapes we handle (learned by inspecting real
// ~/.claude/projects/**/*.jsonl files on this machine):
//
//   {"type":"user", "message":{"role":"user","content": string | [...]}, ...}
//   {"type":"assistant", "message":{"content":[{type:"text"|"thinking"|"tool_use", ...}]}, ...}
//   {"type":"system", "subtype":"stop_hook_summary", ...}
//   {"type":"queue-operation", ...}   -- UI input queue bookkeeping, not agent activity
//   {"type":"last-prompt", ...}       -- UI bookkeeping, not agent activity
//   {"type":"attachment", ...}        -- hook output / tool metadata, not agent activity
//   {"type":"mode", ...}              -- UI permission-mode change
//
// tool_use blocks (assistant) pair with tool_result blocks (user, next line)
// via matching id / tool_use_id. We track pending tool_use calls per session
// so we can emit a "start" event immediately and an "ok"/"error" event once
// the result line arrives.

import { makeEvent } from "./event-schema.js";

// wi-office-life: this was 140 (one status-line length) — the side panel's
// "Hoạt động gần nhất" and Transcript both show `detail` verbatim, so 140
// chars was the actual cause of "cắt cụt" text. 2000 covers a full message/
// tool-preview paragraph; still a hard cap (not the raw content) so one
// pathological tool result can't blow up the per-session ring buffer — even
// at the daemon's 50-session x 500-event ceiling (ws-server.js) that's
// ~50MB worst case, nowhere near the post-OOM #17 heap cap. ponytail: raise
// further only if agents still get cut off in practice.
const MAX_DETAIL_LENGTH = 2000;

/**
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_LENGTH
    ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : oneLine;
}

/**
 * Best-effort short description of a tool call's input, for the speech bubble.
 * @param {string} toolName
 * @param {Object} input
 * @returns {string}
 */
function describeToolInput(toolName, input) {
  if (!input || typeof input !== "object") return toolName;
  if (typeof input.file_path === "string") return `${toolName}: ${input.file_path}`;
  if (typeof input.command === "string") return `${toolName}: ${input.command}`;
  if (typeof input.pattern === "string") return `${toolName}: ${input.pattern}`;
  if (typeof input.description === "string") return `${toolName}: ${input.description}`;
  if (typeof input.prompt === "string") return `${toolName}: ${input.prompt}`;
  return toolName;
}

/**
 * Extract plain text from a tool_result content field, which may be a
 * string or a list of content blocks.
 * @param {string|Array<Object>} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Stateful normalizer for a single transcript file — either a root session
 * or one sub-agent within a root session's tree. Holds the small amount of
 * state needed to pair tool_use with its later tool_result line.
 */
export class SessionNormalizer {
  /**
   * @param {string} sessionId          Claude Code session id (groups events for a root session)
   * @param {Object} [opts]
   * @param {string} [opts.agentId]     character id; defaults to sessionId (root agent)
   * @param {string|null} [opts.parentId]  spawning agent's id; null for the root agent
   * @param {import("./agent-registry.js").AgentRegistry} [opts.registry]
   *   shared per-root-session tool_use -> agentId map, used to (a) register
   *   this normalizer's own tool_use ids so sub-agents it spawns can resolve
   *   their parentId, and (b) resolve this normalizer's own parentId if a
   *   sub-agent's toolUseId wasn't known yet when it was constructed.
   * @param {string|null} [opts.spawnToolUseId]  id of the tool_use block that
   *   spawned this agent, for lazy parentId resolution (sub-agents only).
   */
  constructor(sessionId, { agentId, parentId = null, registry = null, spawnToolUseId = null } = {}) {
    this.sessionId = sessionId;
    this.agentId = agentId ?? sessionId;
    this.parentId = parentId;
    this.registry = registry;
    this.spawnToolUseId = spawnToolUseId;
    /** @type {Map<string, {toolName: string, cwd: string}>} */
    this.pendingToolUse = new Map();
    this.sessionStarted = false;
  }

  /**
   * Resolve `parentId` lazily: a sub-agent's meta.json can be read before
   * the parent's tool_use line spawning it has been tailed, so we retry the
   * registry lookup on every line until it resolves.
   * @returns {string|null}
   */
  _resolveParentId() {
    if (this.parentId !== null) return this.parentId;
    if (!this.spawnToolUseId || !this.registry) return null;
    const resolved = this.registry.resolveParent(this.sessionId, this.spawnToolUseId);
    if (resolved) this.parentId = resolved;
    return this.parentId;
  }

  /**
   * @param {Object} raw parsed JSONL line
   * @returns {import("./event-schema.js").NormalizedEvent[]}
   */
  normalizeLine(raw) {
    if (!raw || typeof raw !== "object") return [];

    const cwd = raw.cwd ?? null;
    const ts = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();
    const events = [];

    if (!this.sessionStarted && (raw.type === "user" || raw.type === "assistant")) {
      this.sessionStarted = true;
      events.push(
        makeEvent({
          id: `${this.agentId}:session_start`,
          type: "session_start",
          sessionId: this.sessionId,
          agentId: this.agentId,
          parentId: this._resolveParentId(),
          cwd,
          ts,
          status: "start",
          detail: "session started",
        })
      );
    }

    if (raw.type === "assistant") {
      events.push(...this._fromAssistant(raw, cwd, ts));
    } else if (raw.type === "user") {
      events.push(...this._fromUser(raw, cwd, ts));
    }
    // queue-operation, last-prompt, attachment, mode, system: intentionally
    // not surfaced as character-visible events (UI/hook bookkeeping, not
    // agent activity a viewer needs to see animated).

    return events;
  }

  /**
   * @private
   */
  _fromAssistant(raw, cwd, ts) {
    const content = raw.message?.content;
    if (!Array.isArray(content)) return [];

    const events = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;

      if (block.type === "tool_use") {
        this.pendingToolUse.set(block.id, { toolName: block.name, cwd });
        this.registry?.registerToolUse(this.sessionId, block.id, this.agentId);
        events.push(
          makeEvent({
            id: `${block.id}:start`,
            type: "tool_call",
            sessionId: this.sessionId,
            agentId: this.agentId,
            parentId: this._resolveParentId(),
            cwd,
            ts,
            tool: block.name,
            status: "start",
            detail: describeToolInput(block.name, block.input),
            meta: { toolUseId: block.id },
          })
        );
      } else if (block.type === "text" && block.text) {
        events.push(
          makeEvent({
            id: `${raw.uuid}:text`,
            type: "speak",
            sessionId: this.sessionId,
            agentId: this.agentId,
            parentId: this._resolveParentId(),
            cwd,
            ts,
            status: "ok",
            detail: truncate(block.text),
            meta: { kind: "text" },
          })
        );
      } else if (block.type === "thinking" && block.thinking) {
        events.push(
          makeEvent({
            id: `${raw.uuid}:thinking`,
            type: "speak",
            sessionId: this.sessionId,
            agentId: this.agentId,
            parentId: this._resolveParentId(),
            cwd,
            ts,
            status: "ok",
            detail: truncate(block.thinking),
            meta: { kind: "thinking" },
          })
        );
      }
    }
    return events;
  }

  /**
   * @private
   */
  _fromUser(raw, cwd, ts) {
    const content = raw.message?.content;
    if (!Array.isArray(content)) return [];

    const events = [];
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "tool_result") continue;

      const pending = this.pendingToolUse.get(block.tool_use_id);
      const toolName = pending?.toolName ?? "unknown_tool";
      this.pendingToolUse.delete(block.tool_use_id);

      const isError = Boolean(block.is_error);
      events.push(
        makeEvent({
          id: `${block.tool_use_id}:end`,
          type: "tool_call",
          sessionId: this.sessionId,
          agentId: this.agentId,
          parentId: this._resolveParentId(),
          cwd: cwd ?? pending?.cwd ?? null,
          ts,
          tool: toolName,
          status: isError ? "error" : "ok",
          detail: truncate(toolResultText(block.content)),
          meta: { toolUseId: block.tool_use_id },
        })
      );
    }
    return events;
  }
}
