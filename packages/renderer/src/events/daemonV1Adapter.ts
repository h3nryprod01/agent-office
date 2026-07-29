import type { OfficeEvent } from "../../../protocol/src/events";
import { statusForTool } from "../sim/model";

/**
 * Translates the daemon's live v1 stream (packages/daemon/src/event-schema.js)
 * into protocol draft v0 events, per the mapping table in
 * packages/protocol/README.md. Temporary by design: delete this file once
 * the pipeline emits draft v0 natively.
 *
 * Since Round 2 the daemon emits real agentId/parentId (sub-agents split
 * out), and since Round 3 the additive "hook_signal" type — both are mapped
 * here so sub-agents render as their own characters and permission waits
 * show up in real time.
 */

/** Daemon v1 shape — duplicated here on purpose; the daemon is JS-only. */
interface DaemonV1Event {
  v: number;
  id: string;
  type: "session_start" | "session_end" | "speak" | "tool_call" | "hook_signal";
  sessionId: string;
  agentId?: string;
  parentId?: string | null;
  harness?: string;
  cwd: string | null;
  /** additive (Round 4): repo derived from cwd by the daemon */
  repo?: string;
  ts: number;
  agent: string;
  tool: string | null;
  status: "start" | "ok" | "error" | null;
  detail: string;
  meta: {
    toolUseId?: string | null;
    kind?: string;
    state?: "waiting_permission" | "working";
    source?: string;
  } | null;
}

/**
 * On boot the daemon replays every transcript from byte 0, so a fresh
 * connect gets hours of history. Anything older than this window is
 * dropped — the renderer is a live view, not a replay tool. (Open item
 * for the pipeline: a "tail from EOF" mode would remove the need.)
 */
const RECENT_WINDOW_MS = 10 * 60 * 1000;

export function createDaemonV1Adapter(nowFn: () => number = Date.now) {
  const seenSessions = new Set<string>();
  const seenAgents = new Set<string>();

  return function adapt(raw: unknown): OfficeEvent[] {
    const e = raw as DaemonV1Event;
    if (!e || e.v !== 1 || typeof e.sessionId !== "string") return [];
    if (nowFn() - e.ts > RECENT_WINDOW_MS) return [];

    const agentId = e.agentId ?? e.sessionId;
    const base = {
      v: 0 as const,
      timestamp: e.ts,
      sessionId: e.sessionId,
      agentId,
      parentId: e.parentId ?? null,
    };

    const out: OfficeEvent[] = [];

    // v1 only marks session_start on an agent's first-ever line; for agents
    // whose start fell outside the recency window, synthesize the spawn from
    // the first event we do see (every v1 event carries agent + cwd).
    if (!seenSessions.has(e.sessionId)) {
      seenSessions.add(e.sessionId);
      out.push({ ...base, id: `${e.id}:v0-session`, type: "session_started", cwd: e.cwd, label: e.agent, repo: e.repo ?? null });
    }
    if (!seenAgents.has(agentId)) {
      seenAgents.add(agentId);
      out.push({ ...base, id: `${e.id}:v0-spawn`, type: "agent_spawned", name: e.agent, role: null, cwd: e.cwd, repo: e.repo ?? null, harness: e.harness ?? null });
    }

    switch (e.type) {
      case "session_start":
        break; // already handled by the first-seen block above

      case "session_end":
        out.push({ ...base, id: `${e.id}:v0-despawn`, type: "agent_despawned", reason: e.detail || null });
        // the daemon emits one session_end per agent; only the root's ends the session
        if (agentId === e.sessionId) {
          out.push({ ...base, id: `${e.id}:v0-end`, type: "session_ended", reason: e.detail || null });
        }
        break;

      case "speak":
        // thinking blocks are too chatty for speech bubbles — text only
        if (e.meta?.kind === "text" && e.detail) {
          out.push({ ...base, id: `${e.id}:v0`, type: "agent_message", text: e.detail });
        }
        break;

      case "tool_call": {
        const tool = e.tool ?? "unknown_tool";
        const toolUseId = e.meta?.toolUseId ?? null;
        if (e.status === "start") {
          out.push({ ...base, id: `${e.id}:v0`, type: "tool_call_started", tool, toolUseId, detail: e.detail || null });
        } else {
          out.push({
            ...base,
            id: `${e.id}:v0`,
            type: "tool_call_finished",
            tool,
            toolUseId,
            ok: e.status !== "error",
            detail: e.detail || null,
          });
          // permission denial is a distinct, higher-priority state than a
          // generic tool error (semantic-mapping.md #10)
          if (e.status === "error" && /has been denied/i.test(e.detail)) {
            out.push({ ...base, id: `${e.id}:v0-blocked`, type: "agent_status_changed", status: "blocked", detail: e.detail });
          }
        }
        break;
      }

      case "hook_signal": {
        // Real-time PreToolUse/PostToolUse channel (Round 3). "waiting_permission"
        // = call unconfirmed past the daemon's grace window; "working" = a
        // previously-reported wait was confirmed to proceed — restore the
        // status the tool implies so the character returns to its station.
        if (e.meta?.state === "waiting_permission") {
          out.push({ ...base, id: `${e.id}:v0`, type: "agent_status_changed", status: "waiting_permission", detail: e.detail || null });
        } else if (e.meta?.state === "working") {
          const status = e.tool ? statusForTool(e.tool) : "working";
          out.push({ ...base, id: `${e.id}:v0`, type: "agent_status_changed", status, detail: e.detail || null });
        }
        break;
      }
    }

    return out;
  };
}
