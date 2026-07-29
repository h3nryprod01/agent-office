import { describe, expect, it } from "vitest";
import { createDaemonV1Adapter } from "../src/events/daemonV1Adapter";

const NOW = 1_000_000_000;

function v1(partial: Record<string, unknown>): unknown {
  return {
    v: 1,
    id: `raw-${Math.abs(JSON.stringify(partial).length)}-${String(partial.type)}-${String(partial.status)}`,
    sessionId: "sess-1",
    cwd: "/repo/acme-web",
    ts: NOW,
    agent: "acme-web",
    tool: null,
    status: null,
    detail: "",
    meta: null,
    ...partial,
  };
}

function makeAdapter() {
  return createDaemonV1Adapter(() => NOW);
}

describe("daemon v1 -> protocol v0 adapter", () => {
  it("first event of a session synthesizes session_started + agent_spawned", () => {
    const adapt = makeAdapter();
    const out = adapt(v1({ type: "session_start", status: "start", detail: "session started" }));
    expect(out.map((e) => e.type)).toEqual(["session_started", "agent_spawned"]);
    expect(out[0]).toMatchObject({ agentId: "sess-1", parentId: null, label: "acme-web" });
  });

  it("synthesizes the spawn even when the first-seen event is a tool_call (start fell outside recency window)", () => {
    const adapt = makeAdapter();
    const out = adapt(v1({ type: "tool_call", tool: "Bash", status: "start", detail: "Bash: ls" }));
    expect(out.map((e) => e.type)).toEqual(["session_started", "agent_spawned", "tool_call_started"]);
  });

  it("only spawns once per session", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const out = adapt(v1({ type: "tool_call", tool: "Read", status: "start" }));
    expect(out.map((e) => e.type)).toEqual(["tool_call_started"]);
  });

  it("speak text becomes agent_message; thinking is dropped", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const text = adapt(v1({ type: "speak", status: "ok", detail: "hello", meta: { kind: "text" } }));
    const thinking = adapt(v1({ type: "speak", status: "ok", detail: "hmm", meta: { kind: "thinking" } }));
    expect(text.map((e) => e.type)).toEqual(["agent_message"]);
    expect(thinking).toEqual([]);
  });

  it("tool_call ok/error map to tool_call_finished", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const ok = adapt(v1({ type: "tool_call", tool: "Read", status: "ok", meta: { toolUseId: "tu1" } }));
    const err = adapt(v1({ type: "tool_call", tool: "Bash", status: "error", detail: "exit 1" }));
    expect(ok[0]).toMatchObject({ type: "tool_call_finished", ok: true, toolUseId: "tu1" });
    expect(err[0]).toMatchObject({ type: "tool_call_finished", ok: false });
    expect(err).toHaveLength(1);
  });

  it("permission denial adds an explicit blocked status change", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const out = adapt(
      v1({ type: "tool_call", tool: "Bash", status: "error", detail: "Permission to use Bash has been denied." }),
    );
    expect(out.map((e) => e.type)).toEqual(["tool_call_finished", "agent_status_changed"]);
    expect(out[1]).toMatchObject({ status: "blocked" });
  });

  it("drops events older than the recency window (daemon boot replay)", () => {
    const adapt = makeAdapter();
    const out = adapt(v1({ type: "tool_call", tool: "Read", status: "start", ts: NOW - 11 * 60 * 1000 }));
    expect(out).toEqual([]);
  });

  it("ignores frames that are not v1 events", () => {
    const adapt = makeAdapter();
    expect(adapt({ hello: "world" })).toEqual([]);
    expect(adapt(null)).toEqual([]);
  });

  it("passes real agentId/parentId through, spawning sub-agents as their own characters", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const out = adapt(
      v1({ type: "tool_call", tool: "Read", status: "start", agentId: "sub-1", parentId: "sess-1" }),
    );
    // new agentId → synthesized spawn for the sub-agent, then the tool call
    expect(out.map((e) => e.type)).toEqual(["agent_spawned", "tool_call_started"]);
    expect(out[1]).toMatchObject({ agentId: "sub-1", parentId: "sess-1", sessionId: "sess-1" });
  });

  it("agent_spawned carries cwd for the side panel", () => {
    const adapt = makeAdapter();
    const out = adapt(v1({ type: "session_start", status: "start" }));
    expect(out[1]).toMatchObject({ type: "agent_spawned", cwd: "/repo/acme-web" });
  });

  it("sub-agent session_end despawns only that agent; root session_end ends the session", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    adapt(v1({ type: "tool_call", tool: "Read", status: "start", agentId: "sub-1", parentId: "sess-1" }));
    const sub = adapt(v1({ type: "session_end", agentId: "sub-1", parentId: "sess-1", detail: "done" }));
    expect(sub.map((e) => e.type)).toEqual(["agent_despawned"]);
    const root = adapt(v1({ type: "session_end", detail: "stopped" }));
    expect(root.map((e) => e.type)).toEqual(["agent_despawned", "session_ended"]);
  });

  it("hook_signal waiting_permission becomes an agent_status_changed alert", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const out = adapt(
      v1({
        type: "hook_signal",
        tool: "Bash",
        status: "start",
        detail: "chờ phê duyệt: Bash",
        meta: { state: "waiting_permission", toolUseId: "tu-9", source: "hook" },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "agent_status_changed",
      status: "waiting_permission",
      agentId: "sess-1",
    });
  });

  it("hook_signal working downgrade restores the tool-implied status", () => {
    const adapt = makeAdapter();
    adapt(v1({ type: "session_start", status: "start" }));
    const out = adapt(
      v1({ type: "hook_signal", tool: "Bash", status: "ok", meta: { state: "working", source: "hook" } }),
    );
    expect(out[0]).toMatchObject({ type: "agent_status_changed", status: "running_command" });
  });
});
