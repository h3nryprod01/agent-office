import { describe, it, expect } from "vitest";
import { newAlerts } from "../src/ui/notify";

// The edge-trigger is the whole point: a toast per real event, never a toast
// per tick (notification fatigue). newAlerts is the pure core behind it.
describe("newAlerts", () => {
  it("fires on enter, stays quiet while unchanged, re-fires on status change, prunes on leave", () => {
    // enters alert → fresh
    let r = newAlerts(new Set(), [{ agentId: "a1", status: "blocked" }]);
    expect(r.fresh).toEqual([{ agentId: "a1", status: "blocked" }]);

    // same status next tick → nothing
    r = newAlerts(r.next, [{ agentId: "a1", status: "blocked" }]);
    expect(r.fresh).toEqual([]);

    // status changed (blocked → error) → re-fire
    r = newAlerts(r.next, [{ agentId: "a1", status: "error" }]);
    expect(r.fresh).toEqual([{ agentId: "a1", status: "error" }]);

    // left the queue → pruned
    r = newAlerts(r.next, []);
    expect(r.next.size).toBe(0);
    expect(r.fresh).toEqual([]);
  });

  it("only the newcomer fires when one agent is already known", () => {
    const r = newAlerts(new Set(["a1:blocked"]), [
      { agentId: "a1", status: "blocked" },
      { agentId: "a2", status: "waiting_permission" },
    ]);
    expect(r.fresh).toEqual([{ agentId: "a2", status: "waiting_permission" }]);
    expect(r.next.size).toBe(2);
  });
});
