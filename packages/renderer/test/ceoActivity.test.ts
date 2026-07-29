import { describe, expect, it } from "vitest";
import { CEO_ACTIVITY_SPOT, ceoActivityDelay, nextCeoActivity, pickCeoActivity } from "../src/render/ceoActivity";
import { CEO_CHAIR } from "../src/render/layout";

describe("pickCeoActivity", () => {
  it("rand=0 picks the first activity, rand near 1 picks the last", () => {
    expect(pickCeoActivity(0)).toBe("desk");
    expect(pickCeoActivity(0.999999)).toBe("board");
  });

  it("every activity has a spot, and desk/phone share the CEO chair", () => {
    for (const activity of ["desk", "cooler", "sofa", "window", "phone", "board"] as const) {
      expect(CEO_ACTIVITY_SPOT[activity]).toBeDefined();
    }
    expect(CEO_ACTIVITY_SPOT.desk).toEqual(CEO_CHAIR);
    expect(CEO_ACTIVITY_SPOT.phone).toEqual(CEO_CHAIR);
  });
});

describe("ceoActivityDelay", () => {
  it("stays within the 20-60s window", () => {
    expect(ceoActivityDelay(0)).toBe(6_000);
    expect(ceoActivityDelay(1)).toBe(18_000);
    expect(ceoActivityDelay(0.5)).toBe(12_000);
  });
});

describe("nextCeoActivity", () => {
  it("blocked always wins, regardless of changeDue or the roll — the CEO snaps back to the desk", () => {
    expect(nextCeoActivity("sofa", true, false, () => 0.9)).toBe("desk");
    expect(nextCeoActivity("sofa", true, true, () => 0.9)).toBe("desk");
    expect(nextCeoActivity("phone", true, false, () => 0)).toBe("desk");
  });

  it("not blocked, no change due: keeps the current activity", () => {
    expect(nextCeoActivity("sofa", false, false, () => 0)).toBe("sofa");
  });

  it("not blocked, change due: rolls a fresh activity from `rand`", () => {
    expect(nextCeoActivity("sofa", false, true, () => 0)).toBe("desk");
    expect(nextCeoActivity("sofa", false, true, () => 0.999999)).toBe("board");
  });
});
