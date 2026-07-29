// Turns one raw Codex CLI rollout JSONL line into zero or more normalized
// events (see event-schema.js) — the Codex counterpart of normalize.js.
//
// Raw rollout line shapes we handle (learned by inspecting 200+ real
// ~/.codex/sessions/**/rollout-*.jsonl files on this machine, codex-cli
// 0.142.x; full mapping table in docs/codex-adapter.md):
//
//   {"timestamp": iso, "type": "session_meta", "payload": {session_id, cwd,
//       thread_source, source, originator, cli_version, ...}}
//   {"timestamp", "type": "turn_context", "payload": {cwd, model, ...}}
//   {"timestamp", "type": "response_item", "payload": {"type": "function_call"
//       | "function_call_output" | "custom_tool_call" | "custom_tool_call_output"
//       | "web_search_call" | "message" | "reasoning", ...}}
//   {"timestamp", "type": "event_msg", "payload": {"type": "agent_message"
//       | "token_count" | "task_started" | "task_complete" | ...}}
//
// tool calls pair with their outputs via matching `call_id` across two
// response_item lines, mirroring the tool_use/tool_result pairing on the
// Claude Code side. Unlike Claude Code, tool outputs carry no is_error
// flag — failure is inferred from the "Process exited with code N" /
// "Exit code: N" preamble Codex prepends to shell tool output.
//
// Sub-agents: a Codex sub-agent thread gets its OWN rollout file whose
// session_meta has thread_source: "subagent" and
// source.subagent.thread_spawn.parent_thread_id — that thread id is another
// rollout file's session_id, so parentId resolves directly with no
// registry/toolUseId indirection.

import { makeEvent } from "./event-schema.js";

const MAX_DETAIL_LENGTH = 140;
const EXIT_CODE_RE = /(?:Process exited with code|Exit code:)\s*(\d+)/;

function truncate(text) {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_DETAIL_LENGTH
    ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : oneLine;
}

/**
 * Best-effort short description of a tool call, for the speech bubble.
 * `arguments` is a JSON-encoded string for function_call; custom_tool_call
 * uses a plain-string `input` instead.
 * @param {string} toolName
 * @param {string|undefined} args
 * @returns {string}
 */
function describeToolCall(toolName, args) {
  if (typeof args !== "string" || !args) return toolName;
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === "object") {
      const interesting = parsed.cmd ?? parsed.command ?? parsed.query ?? parsed.message;
      if (typeof interesting === "string") return truncate(`${toolName}: ${interesting}`);
    }
  } catch {
    // not JSON (custom_tool_call input, e.g. an apply_patch body) — fall through
  }
  return truncate(`${toolName}: ${args}`);
}

/**
 * Tool output is a string ("Chunk ID...\nProcess exited with code 0\n...")
 * or an array of {type, text} blocks.
 * @param {string|Array<Object>} output
 * @returns {string}
 */
function toolOutputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/**
 * Stateful normalizer for a single Codex rollout file (one Codex thread =
 * one character). Holds the call_id -> tool name map needed to pair a
 * *_call line with its later *_call_output line.
 */
export class CodexSessionNormalizer {
  /**
   * @param {string} sessionId thread id from the rollout filename (also in session_meta)
   */
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.parentId = null;
    this.cwd = null;
    this.agentLabel = null; // sub-agent nickname from session_meta, if any
    /** @type {Map<string, string>} call_id -> tool name */
    this.pendingCalls = new Map();
    this.sessionStarted = false;
    this.speakCount = 0; // agent_message lines have no id; a per-file counter
    // is stable across daemon restarts because line order in the file is.
  }

  _base(ts) {
    return {
      sessionId: this.sessionId,
      agentId: this.sessionId,
      parentId: this.parentId,
      cwd: this.cwd,
      ts,
      // Codex names its sub-agents (Lovelace, Franklin, …) — a far better
      // character label than the cwd folder name every sibling shares.
      agent: this.agentLabel ?? undefined,
      harness: "codex",
    };
  }

  /**
   * @param {Object} raw parsed rollout JSONL line
   * @returns {import("./event-schema.js").NormalizedEvent[]}
   */
  normalizeLine(raw) {
    if (!raw || typeof raw !== "object") return [];
    const payload = raw.payload;
    if (!payload || typeof payload !== "object") return [];
    const ts = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();

    if (raw.type === "session_meta") return this._fromSessionMeta(payload, ts);
    if (raw.type === "turn_context") {
      if (typeof payload.cwd === "string") this.cwd = payload.cwd;
      return [];
    }

    let events = [];
    if (raw.type === "response_item") events = this._fromResponseItem(payload, ts);
    else if (raw.type === "event_msg") events = this._fromEventMsg(payload, ts);
    // compacted, inter_agent_communication, ...: bookkeeping, not character
    // activity a viewer needs animated (same policy as normalize.js).

    if (events.length > 0 && !this.sessionStarted) {
      // Activity before any session_meta — happens when the tailer skipped
      // a long-idle file's history (backfill cutoff) and the still-alive
      // process kept appending without a resume. Open the character first.
      this.sessionStarted = true;
      events.unshift(
        makeEvent({
          ...this._base(ts),
          id: `${this.sessionId}:session_start`,
          type: "session_start",
          status: "start",
          detail: "codex session started",
          meta: { inferred: true },
        })
      );
    }
    return events;
  }

  /** @private */
  _fromSessionMeta(payload, ts) {
    if (typeof payload.cwd === "string") this.cwd = payload.cwd;
    const spawn = payload.source?.subagent?.thread_spawn;
    if (typeof spawn?.parent_thread_id === "string") this.parentId = spawn.parent_thread_id;
    if (typeof spawn?.agent_nickname === "string") this.agentLabel = spawn.agent_nickname;
    if (this.sessionStarted) return [];
    this.sessionStarted = true;
    return [
      makeEvent({
        ...this._base(ts),
        id: `${this.sessionId}:session_start`,
        type: "session_start",
        status: "start",
        detail: "codex session started",
        meta: {
          originator: payload.originator ?? null,
          cliVersion: payload.cli_version ?? null,
          agentNickname: spawn?.agent_nickname ?? null,
        },
      }),
    ];
  }

  /** @private */
  _fromResponseItem(payload, ts) {
    const kind = payload.type;

    if (kind === "function_call" || kind === "custom_tool_call") {
      const args = kind === "function_call" ? payload.arguments : payload.input;
      this.pendingCalls.set(payload.call_id, payload.name);
      return [
        makeEvent({
          ...this._base(ts),
          id: `${payload.call_id}:start`,
          type: "tool_call",
          tool: payload.name,
          status: "start",
          detail: describeToolCall(payload.name, args),
          meta: { callId: payload.call_id },
        }),
      ];
    }

    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const toolName = this.pendingCalls.get(payload.call_id) ?? "unknown_tool";
      this.pendingCalls.delete(payload.call_id);
      const text = toolOutputText(payload.output);
      const exitCode = EXIT_CODE_RE.exec(text)?.[1];
      return [
        makeEvent({
          ...this._base(ts),
          id: `${payload.call_id}:end`,
          type: "tool_call",
          tool: toolName,
          status: exitCode !== undefined && exitCode !== "0" ? "error" : "ok",
          detail: truncate(text),
          meta: { callId: payload.call_id },
        }),
      ];
    }

    if (kind === "web_search_call") {
      // Search runs server-side and only appears once, already completed —
      // a single "ok" event, no start/end pair to reconstruct.
      return [
        makeEvent({
          ...this._base(ts),
          id: `${payload.id}:end`,
          type: "tool_call",
          tool: "web_search",
          status: "ok",
          detail: truncate(payload.action?.query ?? "web search"),
        }),
      ];
    }

    // message (role user/developer prompt scaffolding), reasoning (encrypted),
    // tool_search_call/...: not surfaced. Assistant-visible text comes from
    // event_msg agent_message instead, which is plain text.
    return [];
  }

  /** @private */
  _fromEventMsg(payload, ts) {
    if (payload.type === "agent_message" && typeof payload.message === "string") {
      this.speakCount += 1;
      return [
        makeEvent({
          ...this._base(ts),
          id: `${this.sessionId}:speak:${this.speakCount}`,
          type: "speak",
          status: "ok",
          detail: truncate(payload.message),
          meta: { kind: "text" },
        }),
      ];
    }
    // token_count, task_started/complete, turn_aborted, *_end echoes of
    // response_item pairs, sub_agent_activity (the child's own rollout file
    // is the richer signal): intentionally not surfaced.
    return [];
  }
}
