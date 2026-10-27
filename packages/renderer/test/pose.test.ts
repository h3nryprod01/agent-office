import { describe, expect, it } from "vitest";
import {
  ACCEL, advanceBlend, anglesFor, angleDelta, blendedAngles, initialBlend, poseModeFor, stepSpeed, turnToward,
  BLEND_S, SIT_S, type PoseMode,
} from "../src/render/pose";

describe("poseModeFor", () => {
  it("walks whenever it is moving, whatever the status", () => {
    expect(poseModeFor("working", "desk", true, false)).toBe("walk");
    expect(poseModeFor("waiting_permission", "desk", true, false)).toBe("walk");
  });
  it("types at its own desk, but just stands if it has no desk to sit at", () => {
    expect(poseModeFor("working", "desk", false, true)).toBe("type");
    expect(poseModeFor("working", "desk", false, false)).toBe("stand");
  });
  it("puts a hand up when it needs the human", () => {
    expect(poseModeFor("waiting_permission", "desk", false, true)).toBe("wave");
    expect(poseModeFor("blocked", "desk", false, false)).toBe("wave");
  });
  it("acts out each station: shelf reads, arcade plays, meeting talks", () => {
    expect(poseModeFor("reading", "bookshelf", false, false)).toBe("read");
    expect(poseModeFor("running_command", "arcade", false, false)).toBe("play");
    expect(poseModeFor("working", "meeting", false, false)).toBe("talk");
  });
  it("slumps on error and cheers when done", () => {
    expect(poseModeFor("error", "desk", false, true)).toBe("slump");
    expect(poseModeFor("done", "desk", false, true)).toBe("cheer");
  });
});

describe("anglesFor", () => {
  const modes: PoseMode[] = ["stand", "walk", "type", "read", "play", "wave", "talk", "slump", "cheer", "rest"];
  it("is finite and bounded for every mode, at any time", () => {
    for (const m of modes) for (let t = 0; t < 30; t += 0.37) {
      for (const v of Object.values(anglesFor(m, t, t * 14, 1, 3))) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThan(3.2);
      }
    }
  });
  it("typing reaches forward to the keyboard and the hands alternate", () => {
    const a = anglesFor("type", 0.2, 0, 0);
    expect(a.armLx).toBeLessThan(-0.9);
    expect(a.armRx).toBeLessThan(-0.9);
    const spread = Math.max(...Array.from({ length: 60 }, (_, i) => Math.abs(anglesFor("type", i * 0.013, 0, 0).armLx - anglesFor("type", i * 0.013, 0, 0).armRx)));
    expect(spread).toBeGreaterThan(0.1);
  });
  it("waving raises the arm above the shoulder", () => {
    expect(anglesFor("wave", 0, 0, 0).armRz).toBeGreaterThan(2);
  });
  it("walking swings opposite arms and scales with speed", () => {
    const fast = anglesFor("walk", 0, Math.PI / 2, 1), slow = anglesFor("walk", 0, Math.PI / 2, 0.2);
    expect(fast.armLx).toBeCloseTo(-fast.armRx, 5);
    expect(Math.abs(fast.armLx)).toBeGreaterThan(Math.abs(slow.armLx));
    expect(fast.legSwing).toBeGreaterThan(slow.legSwing);
  });
  it("seeds desynchronise neighbours", () => {
    expect(anglesFor("type", 1, 0, 0, 0).armLx).not.toBeCloseTo(anglesFor("type", 1, 0, 0, 0.9).armLx, 3);
  });
});

describe("advanceBlend", () => {
  it("cross-fades a mode change instead of snapping", () => {
    let b = initialBlend("rest");
    b = advanceBlend(b, "wave", false, 0.01);
    expect(b.w).toBeLessThan(1);
    const mid = blendedAngles(b, 0, 0, 0);
    const rest = anglesFor("rest", 0, 0, 0), wave = anglesFor("wave", 0, 0, 0);
    expect(mid.armRz).toBeCloseTo(rest.armRz, 1); // still ~rest right after the change
    for (let i = 0; i < 40; i++) b = advanceBlend(b, "wave", false, BLEND_S / 10);
    expect(b.w).toBe(1);
    expect(blendedAngles(b, 0, 0, 0).armRz).toBeCloseTo(wave.armRz, 5);
  });
  it("sits down and stands up gradually, within SIT_S", () => {
    let b = initialBlend("type");
    b = advanceBlend(b, "type", true, SIT_S / 3);
    expect(b.sit).toBeGreaterThan(0.2);
    expect(b.sit).toBeLessThan(0.5);
    b = advanceBlend(b, "type", true, SIT_S);
    expect(b.sit).toBe(1);
    b = advanceBlend(b, "type", false, SIT_S * 2);
    expect(b.sit).toBe(0);
  });
  it("a second mode change mid-blend doesn't jump back to the old pose", () => {
    let b = advanceBlend(initialBlend("rest"), "wave", false, 0);
    b = advanceBlend(b, "wave", false, BLEND_S * 0.8); // mostly wave now
    b = advanceBlend(b, "type", true, 0);
    expect(b.prev).toBe("wave");
  });
});

describe("walking", () => {
  it("accelerates from rest rather than starting at full speed", () => {
    const v1 = stepSpeed(0, 8.5, 20, 1 / 60);
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeLessThan(1.5);
    expect(v1).toBeCloseTo(ACCEL / 60, 5);
  });
  it("tops out at the cruising speed", () => {
    expect(stepSpeed(8.4, 8.5, 50, 1)).toBe(8.5);
  });
  it("brakes into the target so it never overshoots", () => {
    let pos = 0, v = 8.5;
    const goal = 5;
    for (let i = 0; i < 600 && goal - pos > 0.12; i++) {
      v = stepSpeed(v, 8.5, goal - pos, 1 / 60);
      pos += v / 60;
      expect(pos).toBeLessThanOrEqual(goal + 0.01);
    }
    expect(goal - pos).toBeLessThanOrEqual(0.12);
  });
  it("angleDelta takes the short way round", () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 5);
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 5); // across ±π, not -6
  });
  it("turnToward rotates at a bounded rate and converges", () => {
    expect(turnToward(0, 3, 10, 0.01)).toBeCloseTo(0.1, 5);
    let y = 0;
    for (let i = 0; i < 100; i++) y = turnToward(y, 2, 10, 1 / 60);
    expect(y).toBeCloseTo(2, 5);
  });
});
