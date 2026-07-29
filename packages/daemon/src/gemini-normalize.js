// Turns one Gemini CLI chat message into zero or more normalized events
// (see event-schema.js) — the Gemini counterpart of normalize.js /
// codex-normalize.js.
//
// Real message shapes handled (read from every real session file on this
// machine plus one generated live against gemini-cli 0.29.5; full mapping
// table in docs/gemini-adapter.md):
//
//   {"id": uuid, "timestamp": iso, "type": "user",   "content": [{"text": ...}]}
//   {"id": uuid, "timestamp": iso, "type": "gemini", "content": string,
//    "model": "gemini-2.5-flash", "tokens": {...}, "thoughts": [{subject, description}],
//    "toolCalls": [{id, name, args, result, status, timestamp, resultDisplay,
//                   displayName, description}]}
//   {"id": uuid, "timestamp": iso, "type": "info"|"error", "content": string}
//
// Unlike the Claude Code and Codex sources, a tool call carries BOTH its
// request and its result in one record: gemini-cli's ChatRecordingService
// only ever persists via recordCompletedToolCalls(), so `status` is always
// terminal (success | error | cancelled) — there is no pending/executing
// state to observe. We still emit a start/end PAIR per call so the renderer
// gets its working->idle animation, using the message timestamp for the
// start and the tool call's own timestamp for the end (both real fields).
//
// Sub-agents: gemini-cli 0.29.5 writes no parent/child link into the session
// file, so parentId is always null — every Gemini character is a root agent.

import { makeEvent } from "./event-schema.js";

const MAX_DETAIL_LENGTH = 140;

function truncate(text) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_LENGTH
    ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : oneLine;
}

/**
 * Short description of a tool call for the speech bubble. `args` is a plain
 * object here (Codex JSON-encodes it into a string; Gemini does not).
 * Keys are the real ones observed: dir_path, file_path, pattern, command.
 * @param {string} toolName
 * @param {Object|undefined} args
 * @returns {string}
 */
function describeToolCall(toolName, args) {
  if (!args || typeof args !== "object") return toolName;
  const interesting =
    args.command ?? args.dir_path ?? args.file_path ?? args.pattern ?? args.query ?? args.prompt;
  return typeof interesting === "string" ? truncate(`${toolName}: ${interesting}`) : toolName;
}

/**
 * Human-readable result line. `resultDisplay` is a string in every real
 * session recorded on this machine, but gemini-cli types it as
 * `string | object` (a FileDiff, or an error display) — hence the fallback.
 * Some tools write an empty string on success (`read_file` does), so fall
 * back to restating the call rather than showing a bare tool name.
 * @param {Object} toolCall
 * @returns {string}
 */
function resultDetail(toolCall) {
  const display = toolCall.resultDisplay;
  if (typeof display === "string" && display) return truncate(display);
  if (display && typeof display === "object") {
    const text = display.fileName ?? display.error?.message ?? display.error;
    if (typeof text === "string") return truncate(text);
  }
  return describeToolCall(toolCall.name, toolCall.args);
}

function toolCallStatus(status) {
  // recordCompletedToolCalls only ever writes terminal statuses; "cancelled"
  // and "error" both mean the call did not deliver a result.
  return status === "success" ? "ok" : "error";
}

/**
 * Stateful normalizer for a single Gemini chat session file (one session =
 * one character). Holds only the cwd and whether the character has been
 * opened — the "what have I already emitted" bookkeeping lives in
 * GeminiTailer (the analogue of the Codex tailer's byte offsets), so that
 * evicting this normalizer on session_end can never replay history.
 */
export class GeminiSessionNormalizer {
  /**
   * @param {string} sessionId session id from the chat file's `sessionId` field
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.cwd = null;
    this.sessionStarted = false;
  }

  _base(ts) {
    return {
      sessionId: this.sessionId,
      agentId: this.sessionId,
      parentId: null,
      cwd: this.cwd,
      ts,
      harness: "gemini",
    };
  }

  /**
   * @param {Object} message one entry of the chat file's `messages` array
   * @param {Object} [opts]
   * @param {string|null} [opts.cwd] project root for this session file
   * @param {number} [opts.toolCallOffset] index of the first toolCall not yet
   *   emitted — non-zero when gemini-cli appended more tool calls to a message
   *   we already forwarded (recordToolCalls mutates the last gemini message)
   * @returns {import("./event-schema.js").NormalizedEvent[]}
   */
  normalizeMessage(message, { cwd, toolCallOffset = 0 } = {}) {
    if (!message || typeof message !== "object") return [];
    if (typeof cwd === "string") this.cwd = cwd;
    const ts = message.timestamp ? Date.parse(message.timestamp) : Date.now();

    const events = message.type === "gemini" ? this._fromGemini(message, ts, toolCallOffset) : [];
    // "user": the human's prompt is not character activity (same policy as
    // normalize.js, which only reads tool_result blocks off user lines).
    // "info"/"error": CLI bookkeeping (slash-command usage, skill scan) — not
    // agent activity a viewer needs animated.

    if (!this.sessionStarted && (message.type === "user" || message.type === "gemini")) {
      // Open the character on the first real turn, whichever side speaks —
      // mirrors normalize.js, and keeps info-only sessions from spawning a
      // character that never does anything.
      this.sessionStarted = true;
      events.unshift(
        makeEvent({
          ...this._base(ts),
          id: `${this.sessionId}:session_start`,
          type: "session_start",
          status: "start",
          detail: "gemini session started",
          meta: { model: message.model ?? null },
        })
      );
    }
    return events;
  }

  /** @private */
  _fromGemini(message, ts, toolCallOffset) {
    const events = [];

    // Only the first sight of a message carries its text/thoughts; a
    // re-emission (toolCallOffset > 0) is strictly about appended tool calls.
    if (toolCallOffset === 0) {
      const thoughts = Array.isArray(message.thoughts) ? message.thoughts : [];
      const latest = thoughts[thoughts.length - 1];
      if (typeof latest?.subject === "string" && latest.subject) {
        // Gemini's reasoning is plain text (Codex encrypts its `reasoning`
        // records), so a Gemini character gets the same thinking bubble the
        // claude-code source emits. 1-2 thoughts per message in real data —
        // the latest subject is the one worth showing.
        events.push(
          makeEvent({
            ...this._base(ts),
            id: `${message.id}:thinking`,
            type: "speak",
            status: "ok",
            detail: truncate(latest.subject),
            meta: { kind: "thinking" },
          })
        );
      }

      if (typeof message.content === "string" && message.content) {
        events.push(
          makeEvent({
            ...this._base(ts),
            id: `${message.id}:speak`,
            type: "speak",
            status: "ok",
            detail: truncate(message.content),
            meta: { kind: "text", model: message.model ?? null },
          })
        );
      }
    }

    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const call of toolCalls.slice(toolCallOffset)) {
      if (!call || typeof call.id !== "string") continue;
      const endTs = call.timestamp ? Date.parse(call.timestamp) : ts;
      events.push(
        makeEvent({
          ...this._base(ts),
          id: `${call.id}:start`,
          type: "tool_call",
          tool: call.name,
          status: "start",
          detail: describeToolCall(call.name, call.args),
          meta: { callId: call.id },
        }),
        makeEvent({
          ...this._base(endTs),
          id: `${call.id}:end`,
          type: "tool_call",
          tool: call.name,
          status: toolCallStatus(call.status),
          detail: resultDetail(call),
          meta: { callId: call.id, geminiStatus: call.status ?? null },
        })
      );
    }
    return events;
  }
}
