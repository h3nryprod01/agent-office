// Turns one Hermes message row (from ~/.hermes/state.db, see hermes-tailer.js
// and docs/hermes-adapter.md) into zero or more normalized events — the Hermes
// counterpart of codex-normalize.js / gemini-normalize.js.
//
// Message shapes (OpenAI chat style, observed on a real state.db):
//   user       content = text
//   assistant  content = text | null, tool_calls = [{id, function:{name, arguments(JSON string)}}]
//   tool       tool_call_id, tool_name, content = JSON string | plain text
//   session_meta  bookkeeping row, no content
//
// Hermes records no parent/child link between sessions we can trust as a
// character tree, so every Hermes character is a root agent (parentId null).

import { makeEvent } from "./event-schema.js";

const MAX_DETAIL_LENGTH = 140;

function truncate(text) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…` : oneLine;
}

/** "name: <first interesting argument>" for the speech bubble. */
function describeCall(name, rawArgs) {
  let args = null;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    // arguments is a JSON string by contract; a torn one just loses the preview
  }
  const interesting =
    args && typeof args === "object"
      ? (args.command ?? args.path ?? args.file_path ?? args.url ?? args.query ?? args.pattern ?? args.name)
      : null;
  return typeof interesting === "string" ? truncate(`${name}: ${interesting}`) : name;
}

/** Hermes tool results are JSON with success/error when structured, plain text otherwise. */
function resultFailed(content) {
  try {
    const o = JSON.parse(content);
    return Boolean(o && typeof o === "object" && (o.success === false || o.error));
  } catch {
    return false;
  }
}

export class HermesSessionNormalizer {
  /** @param {string} sessionId Hermes session id */
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.sessionStarted = false;
  }

  /**
   * @param {{id:number, role:string, content:string|null, toolCalls:Object[], toolName:string|null, toolCallId:string|null, ts:number}} message
   * @param {{cwd?:string|null, git_repo_root?:string|null, model?:string|null, started_at?:number, source?:string}} session
   * @returns {import("./event-schema.js").NormalizedEvent[]}
   */
  normalizeMessage(message, session) {
    if (message.role === "session_meta") return [];
    const cwd = session.cwd ?? session.git_repo_root ?? null;
    // no cwd (Telegram/gateway sessions): give Hermes its own office instead of "other"
    const where = cwd ? {} : { repo: "hermes", agent: "hermes" };
    const base = { sessionId: this.sessionId, agentId: this.sessionId, parentId: null, cwd, harness: "hermes", ...where };
    const events = [];

    if (!this.sessionStarted) {
      this.sessionStarted = true;
      events.push(
        makeEvent({
          ...base,
          id: `${this.sessionId}:session_start`,
          type: "session_start",
          ts: Math.round((session.started_at ?? message.ts / 1000) * 1000),
          status: "start",
          detail: "session started",
          meta: { model: session.model ?? null, source: session.source ?? null },
        }),
      );
    }

    if (message.role === "assistant") {
      if (message.content && message.content.trim()) {
        events.push(
          makeEvent({
            ...base,
            id: `${this.sessionId}:${message.id}:text`,
            type: "speak",
            ts: message.ts,
            status: "ok",
            detail: truncate(message.content),
            meta: { kind: "text" },
          }),
        );
      }
      for (const call of message.toolCalls) {
        const name = call.function?.name ?? "unknown_tool";
        events.push(
          makeEvent({
            ...base,
            id: `${call.id}:start`,
            type: "tool_call",
            ts: message.ts,
            tool: name,
            status: "start",
            detail: describeCall(name, call.function?.arguments),
            meta: { toolUseId: call.id },
          }),
        );
      }
    } else if (message.role === "tool") {
      events.push(
        makeEvent({
          ...base,
          id: `${message.toolCallId}:end`,
          type: "tool_call",
          ts: message.ts,
          tool: message.toolName ?? "unknown_tool",
          status: resultFailed(message.content ?? "") ? "error" : "ok",
          detail: truncate(message.content),
          meta: { toolUseId: message.toolCallId },
        }),
      );
    }
    // user rows: the human's prompt is not character activity (same policy as the other adapters)
    return events;
  }
}
