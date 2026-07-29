import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "../../protocol/src/events";
import { EventRecorder, parseReplayFile } from "../src/replay/recorder";
import { ReplayCursor } from "../src/replay/playback";
import { INITIAL_STATE } from "../src/sim/model";
import { reduce } from "../src/sim/reducer";

const SESSION = "s1";
let n = 0;

function make(
  partial: Partial<OfficeEvent> & { type: OfficeEvent["type"]; agentId: string },
  timestamp?: number,
): OfficeEvent {
  n += 1;
  return {
    v: 0,
    id: `e${n}`,
    timestamp: timestamp ?? 1000 + n,
    sessionId: SESSION,
    parentId: null,
    ...partial,
  } as OfficeEvent;
}

/** A tiny session: spawn at t=1000, tool at t=2000, error at t=3000, despawn at t=4000. */
function sampleEvents(): OfficeEvent[] {
  return [
    make({ type: "agent_spawned", agentId: "a1", name: "PM", role: "planner" }, 1000),
    make({ type: "tool_call_started", agentId: "a1", tool: "Read", toolUseId: "t1", detail: null }, 2000),
    make({ type: "tool_call_finished", agentId: "a1", tool: "Read", toolUseId: "t1", ok: false, detail: "boom" }, 3000),
    make({ type: "agent_despawned", agentId: "a1", reason: null }, 4000),
  ];
}

describe("EventRecorder", () => {
  it("records events in order and snapshot returns a copy", () => {
    const rec = new EventRecorder();
    const events = sampleEvents();
    for (const e of events) rec.record(e);
    const snap = rec.snapshot();
    expect(snap).toEqual(events);
    snap.pop();
    expect(rec.size).toBe(4);
  });

  it("caps the buffer, keeping the most recent events", () => {
    const rec = new EventRecorder(10);
    for (let i = 0; i < 25; i++) {
      rec.record(make({ type: "agent_message", agentId: "a1", text: `m${i}` }, 1000 + i));
    }
    const snap = rec.snapshot();
    expect(snap.length).toBe(10);
    expect(snap[snap.length - 1].timestamp).toBe(1024);
    expect(snap[0].timestamp).toBe(1015);
  });

  it("exposes the recorded time range", () => {
    const rec = new EventRecorder();
    expect(rec.startMs).toBe(0);
    expect(rec.endMs).toBe(0);
    for (const e of sampleEvents()) rec.record(e);
    expect(rec.startMs).toBe(1000);
    expect(rec.endMs).toBe(4000);
  });
});

describe("export / import roundtrip", () => {
  it("toJSON → parseReplayFile preserves the events", () => {
    const rec = new EventRecorder();
    for (const e of sampleEvents()) rec.record(e);
    expect(parseReplayFile(rec.toJSON())).toEqual(rec.snapshot());
  });

  it("rejects non-JSON and foreign JSON", () => {
    expect(() => parseReplayFile("not json {")).toThrow(/JSON/);
    expect(() => parseReplayFile('{"hello":"world"}')).toThrow(/replay/);
    expect(() => parseReplayFile('{"format":"agent-office-replay","version":1}')).toThrow(/replay/);
  });

  it("sorts by timestamp and drops malformed entries", () => {
    const [a, b] = sampleEvents();
    const file = JSON.stringify({
      format: "agent-office-replay",
      version: 1,
      exportedAt: 0,
      events: [b, { garbage: true }, null, a],
    });
    const parsed = parseReplayFile(file);
    expect(parsed.map((e) => e.timestamp)).toEqual([1000, 2000]);
  });
});

describe("ReplayCursor — rebuild state at T", () => {
  it("returns the empty initial state before the first event", () => {
    const cursor = new ReplayCursor(sampleEvents());
    expect(cursor.stateAt(999).agents.size).toBe(0);
  });

  it("applies exactly the events with timestamp <= T", () => {
    const cursor = new ReplayCursor(sampleEvents());
    const at2000 = cursor.stateAt(2000);
    const agent = at2000.agents.get("a1")!;
    expect(agent.currentTool).toBe("Read");
    expect(agent.status).toBe("reading");
  });

  it("forward seeks are incremental and match a fresh rebuild", () => {
    const events = sampleEvents();
    const cursor = new ReplayCursor(events);
    cursor.stateAt(1500);
    cursor.stateAt(2500);
    const incremental = cursor.stateAt(3500);
    const fresh = events
      .filter((e) => e.timestamp <= 3500)
      .reduce((s, e) => reduce(s, e), INITIAL_STATE);
    expect(incremental).toEqual(fresh);
    expect(incremental.agents.get("a1")!.status).toBe("error");
  });

  it("backward seeks rebuild from scratch correctly", () => {
    const cursor = new ReplayCursor(sampleEvents());
    expect(cursor.stateAt(4000).agents.get("a1")!.despawnedAt).not.toBeNull();
    const back = cursor.stateAt(1500);
    const agent = back.agents.get("a1")!;
    expect(agent.despawnedAt).toBeNull();
    expect(agent.status).toBe("idle");
    expect(agent.currentTool).toBeNull();
  });

  it("exposes the time range and count", () => {
    const cursor = new ReplayCursor(sampleEvents());
    expect(cursor.startMs).toBe(1000);
    expect(cursor.endMs).toBe(4000);
    expect(cursor.count).toBe(4);
    const empty = new ReplayCursor([]);
    expect(empty.startMs).toBe(0);
    expect(empty.endMs).toBe(0);
    expect(empty.stateAt(123).agents.size).toBe(0);
  });
});
