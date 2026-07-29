/**
 * Agent Office event protocol — DRAFT v0.
 *
 * Contract between the data pipeline (packages/daemon) and the renderer
 * (packages/renderer). The renderer is written against THIS shape; the
 * pipeline is free to change it — see README.md for the current mapping
 * from the daemon's flat v1 stream and for change guidelines.
 *
 * Design rule: every event answers WHO (agentId/parentId/sessionId),
 * WHEN (timestamp), and WHAT (type + payload). The renderer never has to
 * join two events to draw a frame — each event is self-sufficient.
 */

export const PROTOCOL_VERSION = 0;

/** Visual/behavioral state of one character in the office. */
export type AgentStatus =
  | "working" // writing/editing files, generic tool use
  | "reading" // Read/Grep/Glob — at the bookshelf
  | "running_command" // Bash — at the arcade machine
  | "waiting_permission" // pending permission prompt — needs the user NOW
  | "blocked" // stuck for any other reason (denied, waiting on dependency)
  | "error" // tool/API error, may recover
  | "idle" // between turns, waiting for input
  | "done"; // finished its assignment (despawn usually follows)

export type OfficeEventType =
  | "session_started"
  | "session_ended"
  | "agent_spawned"
  | "agent_despawned"
  | "agent_status_changed"
  | "tool_call_started"
  | "tool_call_finished"
  | "agent_message";

/** Fields present on every event. */
export interface OfficeEventBase {
  /** Protocol version, bump on breaking change. */
  v: typeof PROTOCOL_VERSION;
  /** Unique, stable id (transcript uuid or derived) — used for dedup. */
  id: string;
  type: OfficeEventType;
  /** ms since epoch. */
  timestamp: number;
  /** Claude Code session this event belongs to. */
  sessionId: string;
  /**
   * The acting agent. The session's root agent uses agentId === sessionId.
   * Sub-agents get their own id (transcript `agentId` field).
   */
  agentId: string;
  /** Spawning agent, null for the session root. */
  parentId: string | null;
}

export interface SessionStartedEvent extends OfficeEventBase {
  type: "session_started";
  /** Project working dir — identifies the office "zone". */
  cwd: string | null;
  /** Short display label, e.g. repo basename. */
  label: string;
  /**
   * Repo the session belongs to (Round 4, additive): project-root basename,
   * worktree cwds resolved to the root repo, "other" when outside any repo.
   * Optional — older emitters/recordings omit it.
   */
  repo?: string | null;
}

export interface SessionEndedEvent extends OfficeEventBase {
  type: "session_ended";
  /** "stopped" | "inactivity_timeout" | ... — pipeline-defined, free text. */
  reason: string | null;
}

export interface AgentSpawnedEvent extends OfficeEventBase {
  type: "agent_spawned";
  /** Display name for the character. */
  name: string;
  /**
   * Role label when it can be derived from real data (agents/*.md
   * frontmatter), else null — the renderer must NOT invent roles.
   */
  role: string | null;
  /**
   * Project working dir of the agent (added in Round 3 for the Mission
   * Control side panel). Optional — additive field, older emitters omit it.
   */
  cwd?: string | null;
  /** Repo of the agent (Round 4, additive) — see SessionStartedEvent.repo. */
  repo?: string | null;
  /**
   * Which CLI produced this agent's transcript, e.g. "claude-code" | "codex"
   * (daemon event-schema). Optional additive field (Round 4b) — the renderer
   * uses it to pick a character skin (Codex agents render as robots).
   */
  harness?: string | null;
}

export interface AgentDespawnedEvent extends OfficeEventBase {
  type: "agent_despawned";
  reason: string | null;
}

export interface AgentStatusChangedEvent extends OfficeEventBase {
  type: "agent_status_changed";
  status: AgentStatus;
  /** Short human-readable context, e.g. "waiting for Bash approval". */
  detail: string | null;
}

export interface ToolCallStartedEvent extends OfficeEventBase {
  type: "tool_call_started";
  /** Tool name as seen in the transcript, e.g. "Bash", "mcp__x__y". */
  tool: string;
  /** transcript tool_use id — pairs start/finish. */
  toolUseId: string | null;
  /** Short summary for tooltips, e.g. "Read src/main.ts". */
  detail: string | null;
}

export interface ToolCallFinishedEvent extends OfficeEventBase {
  type: "tool_call_finished";
  tool: string;
  toolUseId: string | null;
  ok: boolean;
  detail: string | null;
}

export interface AgentMessageEvent extends OfficeEventBase {
  type: "agent_message";
  /** Short text for the speech bubble (renderer truncates as needed). */
  text: string;
}

export type OfficeEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | AgentSpawnedEvent
  | AgentDespawnedEvent
  | AgentStatusChangedEvent
  | ToolCallStartedEvent
  | ToolCallFinishedEvent
  | AgentMessageEvent;

export const AGENT_STATUSES: readonly AgentStatus[] = [
  "working",
  "reading",
  "running_command",
  "waiting_permission",
  "blocked",
  "error",
  "idle",
  "done",
];
