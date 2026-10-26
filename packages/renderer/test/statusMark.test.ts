import { describe, expect, it } from "vitest";
import { markFor, MARK_PULSE } from "../src/render3d/statusMark";
import type { AgentStatus } from "../../protocol/src/events";

describe("markFor", () => {
  it("flags exactly the states that need a human, plus the ones that just ended", () => {
    expect(markFor("waiting_permission")).toBe("alert");
    expect(markFor("blocked")).toBe("alert");
    expect(markFor("error")).toBe("error");
    expect(markFor("done")).toBe("done");
  });
  it("stays quiet while an agent is simply busy", () => {
    for (const s of ["working", "reading", "running_command", "idle"] as AgentStatus[]) expect(markFor(s)).toBeNull();
  });
  it("copes with no status at all", () => {
    expect(markFor(null)).toBeNull();
    expect(markFor(undefined)).toBeNull();
  });
  it("pulses alerts harder than a finished tick", () => {
    expect(MARK_PULSE.alert).toBeGreaterThan(MARK_PULSE.done);
  });
});
