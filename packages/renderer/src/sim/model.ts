import { t, type Key } from "../i18n";
import type { AgentStatus } from "../../../protocol/src/events";

/** Where a character stands in the office. Placeholder-station ids. */
export type StationId =
  | "desk" // own desk — writing/editing/working
  | "bookshelf" // reading files
  | "arcade" // running commands (terminal as arcade machine)
  | "meeting"; // delegating to sub-agents

/** One row of an agent's recent-activity feed (side panel timeline). */
export interface TimelineEntry {
  ts: number;
  kind: "tool" | "result" | "status" | "message";
  text: string;
  /** Raw tool name (tool/result kinds) — lets the side panel de-jargon it. */
  tool?: string;
  /** Raw status (status kind) — lets the side panel show a friendly label. */
  status?: AgentStatus;
}

/**
 * Plain-language label for a raw agent status, in the current UI language.
 *
 * Deliberately not the enum name: someone glancing at the office should read
 * "Waiting for you", not `waiting_permission`.
 */
export function statusLabel(status: AgentStatus): string {
  return t(`status.${status}` as Key);
}

/** Timeline rows kept per agent — enough for the side panel, tiny in memory. */
export const TIMELINE_LIMIT = 30;

/** Pure data model of one character. No Pixi objects in here. */
export interface AgentModel {
  agentId: string;
  parentId: string | null;
  sessionId: string;
  name: string;
  role: string | null;
  cwd: string | null;
  /** Repo/office the agent belongs to ("other" when unknown). */
  repo: string;
  /** Source CLI ("claude-code" | "codex" | ...), null when unknown. */
  harness: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  /** When the current status began (for "waiting for 43s" readouts). */
  statusSince: number;
  station: StationId;
  currentTool: string | null;
  message: { text: string; at: number } | null;
  /** Most recent activity, oldest first, capped at TIMELINE_LIMIT. */
  timeline: readonly TimelineEntry[];
  spawnedAt: number;
  despawnedAt: number | null;
}

export interface OfficeState {
  sessionId: string | null;
  sessionLabel: string | null;
  sessionEnded: boolean;
  /** insertion order = spawn order (used for desk assignment) */
  agents: ReadonlyMap<string, AgentModel>;
}

export const INITIAL_STATE: OfficeState = {
  sessionId: null,
  sessionLabel: null,
  sessionEnded: false,
  agents: new Map(),
};

/**
 * Fallback repo derivation from a cwd path — string rules only (the daemon's
 * fs-aware version in event-schema.js is authoritative; this covers mock mode
 * and old recordings that predate the `repo` field).
 */
export function repoFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "other";
  const wt = cwd.indexOf("/.claude/worktrees/");
  const root = wt > 0 ? cwd.slice(0, wt) : cwd;
  const parts = root.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "other";
}

/** Which station a tool call happens at (semantic-mapping.md §2). */
export function stationForTool(tool: string): StationId {
  if (/^(Read|Grep|Glob|NotebookRead)$/.test(tool)) return "bookshelf";
  if (tool === "Bash") return "arcade";
  if (/^(Task|Agent|Workflow)$/.test(tool)) return "meeting";
  return "desk";
}

/** Status implied by starting a tool call (only for non-alert statuses). */
export function statusForTool(tool: string): AgentStatus {
  const station = stationForTool(tool);
  if (station === "bookshelf") return "reading";
  if (station === "arcade") return "running_command";
  return "working";
}

/** Alert statuses freeze the character in place until they clear. */
export function isAlertStatus(status: AgentStatus): boolean {
  return status === "waiting_permission" || status === "blocked" || status === "error";
}

/** Station implied by a plain status change (no tool context). */
export function stationForStatus(status: AgentStatus, current: StationId): StationId {
  switch (status) {
    case "reading":
      return "bookshelf";
    case "running_command":
      return "arcade";
    case "working":
    case "idle":
    case "done":
      return "desk";
    default:
      // alert statuses: stay where the trouble happened
      return current;
  }
}
