import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "../../protocol/src/events";
import { INITIAL_STATE, type OfficeState } from "../src/sim/model";
import { reduce } from "../src/sim/reducer";

const SESSION = "s1";
let n = 0;

function make(partial: Partial<OfficeEvent> & { type: OfficeEvent["type"]; agentId: string }): OfficeEvent {
  n += 1;
  return {
    v: 0,
    id: `e${n}`,
    timestamp: 1000 + n,
    sessionId: SESSION,
    parentId: null,
    ...partial,
  } as OfficeEvent;
}

function spawnPm(state: OfficeState = INITIAL_STATE): OfficeState {
  return reduce(state, make({ type: "agent_spawned", agentId: SESSION, name: "PM", role: "planner" }));
}

describe("reduce — lifecycle", () => {
  it("session_started sets session metadata", () => {
    const s = reduce(
      INITIAL_STATE,
      make({ type: "session_started", agentId: SESSION, cwd: "/repo", label: "repo" }),
    );
    expect(s.sessionId).toBe(SESSION);
    expect(s.sessionLabel).toBe("repo");
  });

  it("agent_spawned adds an idle agent at its desk", () => {
    const s = spawnPm();
    const pm = s.agents.get(SESSION)!;
    expect(pm.status).toBe("idle");
    expect(pm.station).toBe("desk");
    expect(pm.role).toBe("planner");
  });

  it("agent_despawned marks the agent done with a despawn time", () => {
    const s = reduce(spawnPm(), make({ type: "agent_despawned", agentId: SESSION, reason: "done" }));
    const pm = s.agents.get(SESSION)!;
    expect(pm.despawnedAt).not.toBeNull();
    expect(pm.status).toBe("done");
  });

  it("never mutates the previous state", () => {
    const before = spawnPm();
    const beforeAgent = before.agents.get(SESSION)!;
    reduce(before, make({ type: "agent_status_changed", agentId: SESSION, status: "working", detail: null }));
    expect(before.agents.get(SESSION)).toBe(beforeAgent);
    expect(beforeAgent.status).toBe("idle");
  });
});

describe("reduce — tool calls drive station + status", () => {
  it.each([
    ["Read", "bookshelf", "reading"],
    ["Grep", "bookshelf", "reading"],
    ["Bash", "arcade", "running_command"],
    ["Write", "desk", "working"],
    ["Task", "meeting", "working"],
  ])("%s → station %s, status %s", (tool, station, status) => {
    const s = reduce(
      spawnPm(),
      make({ type: "tool_call_started", agentId: SESSION, tool, toolUseId: null, detail: null }),
    );
    const pm = s.agents.get(SESSION)!;
    expect(pm.station).toBe(station);
    expect(pm.status).toBe(status);
    expect(pm.currentTool).toBe(tool);
  });

  it("failed tool_call_finished flips status to error", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "tool_call_started", agentId: SESSION, tool: "Bash", toolUseId: null, detail: null }));
    s = reduce(s, make({ type: "tool_call_finished", agentId: SESSION, tool: "Bash", toolUseId: null, ok: false, detail: "boom" }));
    const pm = s.agents.get(SESSION)!;
    expect(pm.status).toBe("error");
    expect(pm.currentTool).toBeNull();
  });

  it("successful finish keeps the current status", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "tool_call_started", agentId: SESSION, tool: "Read", toolUseId: null, detail: null }));
    s = reduce(s, make({ type: "tool_call_finished", agentId: SESSION, tool: "Read", toolUseId: null, ok: true, detail: null }));
    expect(s.agents.get(SESSION)!.status).toBe("reading");
  });
});

describe("reduce — alert statuses", () => {
  it("waiting_permission keeps the agent where it was", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "tool_call_started", agentId: SESSION, tool: "Bash", toolUseId: null, detail: null }));
    s = reduce(s, make({ type: "agent_status_changed", agentId: SESSION, status: "waiting_permission", detail: "rm -rf" }));
    const pm = s.agents.get(SESSION)!;
    expect(pm.status).toBe("waiting_permission");
    expect(pm.station).toBe("arcade"); // frozen in place, not walked back to desk
  });

  it("a new tool call cannot override an alert status", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "agent_status_changed", agentId: SESSION, status: "waiting_permission", detail: null }));
    s = reduce(s, make({ type: "tool_call_started", agentId: SESSION, tool: "Read", toolUseId: null, detail: null }));
    expect(s.agents.get(SESSION)!.status).toBe("waiting_permission");
  });

  it("error recovers via an explicit status change", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "tool_call_finished", agentId: SESSION, tool: "Bash", toolUseId: null, ok: false, detail: null }));
    s = reduce(s, make({ type: "agent_status_changed", agentId: SESSION, status: "working", detail: "fixing" }));
    const pm = s.agents.get(SESSION)!;
    expect(pm.status).toBe("working");
    expect(pm.station).toBe("desk");
  });
});

describe("reduce — Mission Control fields (side panel data)", () => {
  it("agent_spawned records sessionId, cwd and statusSince", () => {
    const s = reduce(
      INITIAL_STATE,
      make({ type: "agent_spawned", agentId: SESSION, name: "PM", role: null, cwd: "/repo", timestamp: 5_000 }),
    );
    const pm = s.agents.get(SESSION)!;
    expect(pm.sessionId).toBe(SESSION);
    expect(pm.cwd).toBe("/repo");
    expect(pm.statusSince).toBe(5_000);
  });

  it("statusSince updates only when the status actually changes", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "agent_status_changed", agentId: SESSION, status: "working", detail: null, timestamp: 2_000 }));
    s = reduce(s, make({ type: "agent_status_changed", agentId: SESSION, status: "working", detail: "still", timestamp: 9_000 }));
    expect(s.agents.get(SESSION)!.statusSince).toBe(2_000);
    s = reduce(s, make({ type: "agent_status_changed", agentId: SESSION, status: "error", detail: null, timestamp: 12_000 }));
    expect(s.agents.get(SESSION)!.statusSince).toBe(12_000);
  });

  it("tool calls, results, statuses and messages land in the timeline in order", () => {
    let s = spawnPm();
    s = reduce(s, make({ type: "tool_call_started", agentId: SESSION, tool: "Bash", toolUseId: null, detail: "Bash: npm test" }));
    s = reduce(s, make({ type: "tool_call_finished", agentId: SESSION, tool: "Bash", toolUseId: null, ok: false, detail: "3 failed" }));
    s = reduce(s, make({ type: "agent_message", agentId: SESSION, text: "đang sửa" }));
    const kinds = s.agents.get(SESSION)!.timeline.map((t) => t.kind);
    expect(kinds).toEqual(["tool", "result", "message"]);
    expect(s.agents.get(SESSION)!.timeline[1].text).toContain("✗ Bash");
  });

  it("timeline is capped and keeps the newest entries", () => {
    let s = spawnPm();
    for (let i = 0; i < 40; i++) {
      s = reduce(s, make({ type: "agent_message", agentId: SESSION, text: `m${i}` }));
    }
    const timeline = s.agents.get(SESSION)!.timeline;
    expect(timeline.length).toBeLessThanOrEqual(30);
    expect(timeline[timeline.length - 1].text).toBe("m39");
  });
});

describe("reduce — messages and robustness", () => {
  it("agent_message stores text with its timestamp", () => {
    const s = reduce(spawnPm(), make({ type: "agent_message", agentId: SESSION, text: "hello" }));
    expect(s.agents.get(SESSION)!.message?.text).toBe("hello");
  });

  it("events for an unknown agent create an implicit stub instead of crashing", () => {
    const s = reduce(
      INITIAL_STATE,
      make({ type: "agent_status_changed", agentId: "ghost-123456", parentId: SESSION, status: "working", detail: null }),
    );
    const ghost = s.agents.get("ghost-123456")!;
    expect(ghost).toBeDefined();
    expect(ghost.parentId).toBe(SESSION);
    expect(ghost.status).toBe("working");
  });
});

describe("friendly agent naming (coder-NN)", () => {
  it("numbers per office+role and reuses a freed slot", () => {
    let s: OfficeState = INITIAL_STATE;
    s = reduce(s, make({ type: "agent_spawned", agentId: "a", repo: "demo-app" }));
    s = reduce(s, make({ type: "agent_spawned", agentId: "b", repo: "demo-app" }));
    s = reduce(s, make({ type: "agent_spawned", agentId: "c", repo: "demo-app" }));
    expect(s.agents.get("a")!.name).toBe("coder-01");
    expect(s.agents.get("b")!.name).toBe("coder-02");
    expect(s.agents.get("c")!.name).toBe("coder-03");

    // despawn coder-02 → a new agent takes the freed slot, not coder-04
    s = reduce(s, make({ type: "agent_despawned", agentId: "b" }));
    s = reduce(s, make({ type: "agent_spawned", agentId: "d", repo: "demo-app" }));
    expect(s.agents.get("d")!.name).toBe("coder-02");

    // a different office numbers independently, with its own inferred role
    s = reduce(s, make({ type: "agent_spawned", agentId: "m", repo: "acme-marketing" }));
    expect(s.agents.get("m")!.name).toBe("marketing-01");
  });
});
