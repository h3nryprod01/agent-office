import type { OfficeEvent } from "../../../protocol/src/events";
import {
  TIMELINE_LIMIT,
  type AgentModel,
  type OfficeState,
  type TimelineEntry,
  isAlertStatus,
  repoFromCwd,
  stationForStatus,
  stationForTool,
  statusForTool,
} from "./model";
import { friendlyName, roleOf } from "./agentNames";

/**
 * Single entry point from event stream to render model. Pure and immutable:
 * every call returns a NEW state, inputs are never mutated. This is the one
 * file to touch when the protocol draft changes.
 */
export function reduce(state: OfficeState, event: OfficeEvent): OfficeState {
  switch (event.type) {
    case "session_started":
      return {
        ...state,
        sessionId: event.sessionId,
        sessionLabel: event.label,
        sessionEnded: false,
      };

    case "session_ended":
      return { ...state, sessionEnded: true };

    case "agent_spawned": {
      // repo: explicit field > derived from cwd > inherited from the parent
      // (sub-agents often spawn without a cwd but work in the parent's repo)
      const parent = event.parentId ? state.agents.get(event.parentId) : undefined;
      const repo = event.repo ?? (event.cwd ? repoFromCwd(event.cwd) : parent?.repo ?? "other");
      const role = roleOf(repo, event.role);
      const agent: AgentModel = {
        agentId: event.agentId,
        parentId: event.parentId,
        sessionId: event.sessionId,
        // Friendly "coder-01" name replaces the random worktree codename; the
        // raw worktree path stays in `cwd`. Sequence is stable per office+role.
        name: friendlyName(role, nextRoleIndex(state.agents, repo, role)),
        role: event.role,
        cwd: event.cwd ?? null,
        repo,
        harness: event.harness ?? null,
        status: "idle",
        statusDetail: null,
        statusSince: event.timestamp,
        station: "desk",
        currentTool: null,
        message: null,
        timeline: [],
        spawnedAt: event.timestamp,
        despawnedAt: null,
      };
      return withAgent(state, agent);
    }

    case "agent_despawned":
      return updateAgent(state, event, (a) => ({
        ...a,
        despawnedAt: event.timestamp,
        status: "done",
        statusSince: event.timestamp,
      }));

    case "agent_status_changed":
      return updateAgent(state, event, (a) => ({
        ...withTimeline(a, {
          ts: event.timestamp,
          kind: "status",
          text: event.detail ? `${event.status} — ${event.detail}` : event.status,
          status: event.status,
        }),
        status: event.status,
        statusDetail: event.detail,
        statusSince: event.status === a.status ? a.statusSince : event.timestamp,
        station: stationForStatus(event.status, a.station),
      }));

    case "tool_call_started": {
      return updateAgent(state, event, (a) => {
        const nextStatus = isAlertStatus(a.status) ? a.status : statusForTool(event.tool);
        return {
          ...withTimeline(a, { ts: event.timestamp, kind: "tool", text: event.detail ?? event.tool, tool: event.tool }),
          currentTool: event.tool,
          station: isAlertStatus(a.status) ? a.station : stationForTool(event.tool),
          status: nextStatus,
          statusSince: nextStatus === a.status ? a.statusSince : event.timestamp,
          statusDetail: event.detail,
        };
      });
    }

    case "tool_call_finished":
      return updateAgent(state, event, (a) => ({
        ...withTimeline(a, {
          ts: event.timestamp,
          kind: "result",
          text: event.ok ? `✓ ${event.tool}` : `✗ ${event.tool}${event.detail ? ` — ${event.detail}` : ""}`,
          tool: event.tool,
        }),
        currentTool: null,
        status: event.ok ? a.status : "error",
        statusSince: event.ok ? a.statusSince : event.timestamp,
        statusDetail: event.detail ?? a.statusDetail,
      }));

    case "agent_message":
      return updateAgent(state, event, (a) => ({
        ...withTimeline(a, { ts: event.timestamp, kind: "message", text: event.text }),
        message: { text: event.text, at: event.timestamp },
      }));
  }
}

function withAgent(state: OfficeState, agent: AgentModel): OfficeState {
  const agents = new Map(state.agents);
  agents.set(agent.agentId, agent);
  return { ...state, agents };
}

/** Append a timeline entry, keeping the buffer capped (immutable). */
function withTimeline(agent: AgentModel, entry: TimelineEntry): AgentModel {
  const timeline = [...agent.timeline.slice(-(TIMELINE_LIMIT - 1)), entry];
  return { ...agent, timeline };
}

/**
 * Apply `fn` to the event's agent. Unknown agentId (out-of-order stream)
 * creates an implicit stub first so the renderer never drops events.
 */
/** Next 1-based sequence for a (repo, role) pair — counts existing agents that
 *  resolve to the same role in the same office, so names read coder-01, -02… */
function nextRoleIndex(
  agents: ReadonlyMap<string, AgentModel>,
  repo: string,
  role: string,
): number {
  // Lowest free 1-based slot among LIVE agents of this office+role, so despawned
  // agents free their number and the live team reads coder-01, -02, -03 (not
  // -36). Parses the already-assigned "<role>-NN" names to find used slots.
  const used = new Set<number>();
  for (const a of agents.values()) {
    if (a.despawnedAt !== null) continue;
    if (a.repo !== repo || roleOf(a.repo, a.role) !== role) continue;
    if (a.name.startsWith(`${role}-`)) {
      const num = Number(a.name.slice(role.length + 1));
      if (Number.isInteger(num) && num > 0) used.add(num);
    }
  }
  let i = 1;
  while (used.has(i)) i++;
  return i;
}

function updateAgent(
  state: OfficeState,
  event: OfficeEvent,
  fn: (agent: AgentModel) => AgentModel,
): OfficeState {
  const existing = state.agents.get(event.agentId) ?? implicitAgent(event);
  return withAgent(state, fn(existing));
}

function implicitAgent(event: OfficeEvent): AgentModel {
  return {
    agentId: event.agentId,
    parentId: event.parentId,
    sessionId: event.sessionId,
    name: shortId(event.agentId),
    role: null,
    cwd: null,
    repo: "other",
    harness: null,
    status: "idle",
    statusDetail: null,
    statusSince: event.timestamp,
    station: "desk",
    currentTool: null,
    message: null,
    timeline: [],
    spawnedAt: event.timestamp,
    despawnedAt: null,
  };
}

function shortId(id: string): string {
  return id.length > 10 ? `agent-${id.slice(0, 6)}` : id;
}
