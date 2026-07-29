import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "../../protocol/src/events";
import { INITIAL_STATE, type OfficeState } from "../src/sim/model";
import { reduce } from "../src/sim/reducer";
import { CEO_QUEUE_DELAY_MS, ceoQueue, formatSince, interventionQueue } from "../src/sim/selectors";

let seq = 0;
function apply(state: OfficeState, partial: Partial<OfficeEvent> & { type: OfficeEvent["type"] }): OfficeState {
  seq += 1;
  return reduce(state, {
    v: 0,
    id: `e-${seq}`,
    timestamp: 1_000,
    sessionId: "sess",
    agentId: "a1",
    parentId: null,
    ...partial,
  } as OfficeEvent);
}

function spawn(state: OfficeState, agentId: string, name = agentId): OfficeState {
  return apply(state, { type: "agent_spawned", agentId, name, role: null });
}

const setStatus = (
  state: OfficeState,
  agentId: string,
  status: string,
  timestamp: number,
  detail: string | null = null,
): OfficeState => apply(state, { type: "agent_status_changed", agentId, status, detail, timestamp } as Partial<OfficeEvent> & { type: "agent_status_changed" });

describe("interventionQueue", () => {
  it("returns only alert-status agents", () => {
    let s = spawn(INITIAL_STATE, "ok-agent");
    s = spawn(s, "stuck-agent");
    s = setStatus(s, "stuck-agent", "waiting_permission", 2_000);
    const q = interventionQueue(s);
    expect(q.map((a) => a.agentId)).toEqual(["stuck-agent"]);
  });

  it("orders waiting_permission > error > blocked, then by longest-stuck", () => {
    let s = INITIAL_STATE;
    for (const id of ["b", "e", "w-new", "w-old"]) s = spawn(s, id);
    s = setStatus(s, "b", "blocked", 1_000);
    s = setStatus(s, "e", "error", 1_500);
    s = setStatus(s, "w-old", "waiting_permission", 2_000);
    s = setStatus(s, "w-new", "waiting_permission", 3_000);
    expect(interventionQueue(s).map((a) => a.agentId)).toEqual(["w-old", "w-new", "e", "b"]);
  });

  it("drops despawned agents even if their last status was an alert", () => {
    let s = spawn(INITIAL_STATE, "gone");
    s = setStatus(s, "gone", "error", 2_000);
    s = apply(s, { type: "agent_despawned", agentId: "gone", reason: null, timestamp: 3_000 });
    expect(interventionQueue(s)).toEqual([]);
  });

  it("clears an agent from the queue when its status recovers", () => {
    let s = spawn(INITIAL_STATE, "flappy");
    s = setStatus(s, "flappy", "waiting_permission", 2_000);
    expect(interventionQueue(s)).toHaveLength(1);
    s = setStatus(s, "flappy", "working", 4_000);
    expect(interventionQueue(s)).toEqual([]);
  });
});

describe("ceoQueue", () => {
  it("is empty with no alert-status agents", () => {
    const s = spawn(INITIAL_STATE, "ok-agent");
    expect(ceoQueue(s, 100_000)).toEqual([]);
  });

  it("holds off until CEO_QUEUE_DELAY_MS has elapsed since statusSince", () => {
    let s = spawn(INITIAL_STATE, "stuck");
    s = setStatus(s, "stuck", "waiting_permission", 2_000);
    expect(ceoQueue(s, 2_000 + CEO_QUEUE_DELAY_MS - 1).map((a) => a.agentId)).toEqual([]);
    expect(ceoQueue(s, 2_000 + CEO_QUEUE_DELAY_MS).map((a) => a.agentId)).toEqual(["stuck"]);
  });

  it("excludes error — only waiting_permission/blocked join the line", () => {
    let s = spawn(INITIAL_STATE, "broken");
    s = setStatus(s, "broken", "error", 2_000);
    expect(ceoQueue(s, 200_000)).toEqual([]);
  });

  it("drops despawned agents even once past the delay", () => {
    let s = spawn(INITIAL_STATE, "gone");
    s = setStatus(s, "gone", "blocked", 2_000);
    s = apply(s, { type: "agent_despawned", agentId: "gone", reason: null, timestamp: 3_000 });
    expect(ceoQueue(s, 200_000)).toEqual([]);
  });

  it("orders FIFO by statusSince regardless of waiting_permission vs blocked", () => {
    let s = INITIAL_STATE;
    for (const id of ["late", "early", "mid"]) s = spawn(s, id);
    s = setStatus(s, "late", "waiting_permission", 3_000);
    s = setStatus(s, "early", "blocked", 1_000);
    s = setStatus(s, "mid", "waiting_permission", 2_000);
    expect(ceoQueue(s, 100_000).map((a) => a.agentId)).toEqual(["early", "mid", "late"]);
  });

  it("clears once status recovers, even after joining the line", () => {
    let s = spawn(INITIAL_STATE, "flappy");
    s = setStatus(s, "flappy", "blocked", 2_000);
    expect(ceoQueue(s, 200_000)).toHaveLength(1);
    s = setStatus(s, "flappy", "working", 200_000);
    expect(ceoQueue(s, 200_000)).toEqual([]);
  });
});

describe("formatSince", () => {
  it("formats seconds and minutes", () => {
    expect(formatSince(0, 43_000)).toBe("43s");
    expect(formatSince(0, 125_000)).toBe("2m 05s");
    expect(formatSince(5_000, 4_000)).toBe("0s"); // clock skew clamps at 0
  });
});
