import { describe, expect, it } from "vitest";
import {
  easeInOutQuad,
  easeOutBack,
  fidgetDelay,
  lerpColor,
  typingRhythm,
  walkDirection,
} from "../src/render/anim";
import {
  CEO_CHAIR,
  CEO_DESK,
  CEO_QUEUE_SLOTS,
  CEO_SPOT,
  DECOR,
  DESK_COUNT,
  ceoQueueSlot,
  deskFootprint,
  deskSlot,
} from "../src/render/layout";
import { dist } from "../src/render/iso";

describe("easeInOutQuad", () => {
  it("hits the endpoints and midpoint exactly", () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(0.5)).toBe(0.5);
    expect(easeInOutQuad(1)).toBe(1);
  });

  it("is monotonically increasing (no rubber-banding mid-walk)", () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = easeInOutQuad(t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("starts and ends slow (ease-in-out, not linear)", () => {
    expect(easeInOutQuad(0.1)).toBeLessThan(0.1);
    expect(easeInOutQuad(0.9)).toBeGreaterThan(0.9);
  });
});

describe("easeOutBack", () => {
  it("lands on 1 and overshoots on the way", () => {
    expect(easeOutBack(1)).toBeCloseTo(1);
    expect(easeOutBack(0.8)).toBeGreaterThan(1); // the "pop"
  });
});

describe("walkDirection", () => {
  it("maps the dominant grid axis to the sprite direction", () => {
    expect(walkDirection(1, 0.2)).toBe("E");
    expect(walkDirection(-1, 0.2)).toBe("W");
    expect(walkDirection(0.2, 1)).toBe("S");
    expect(walkDirection(0.2, -1)).toBe("N");
  });
});

describe("lerpColor", () => {
  it("returns the endpoints at t=0/1 and clamps outside", () => {
    expect(lerpColor(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
    expect(lerpColor(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
    expect(lerpColor(0xff0000, 0x0000ff, 5)).toBe(0x0000ff);
    expect(lerpColor(0xff0000, 0x0000ff, -5)).toBe(0xff0000);
  });

  it("mixes channels independently", () => {
    expect(lerpColor(0x000000, 0xff00ff, 0.5)).toBe(0x800080);
  });
});

describe("fidgetDelay / typingRhythm", () => {
  it("fidget delay stays in the 3-8s window", () => {
    expect(fidgetDelay(0)).toBe(3000);
    expect(fidgetDelay(0.999)).toBeLessThan(8000);
  });

  it("typing has a fast burst and a near-pause phase", () => {
    expect(typingRhythm(0)).toBeGreaterThan(0.1); // burst
    expect(typingRhythm(1200)).toBeLessThan(0.05); // pause
    expect(typingRhythm(1200)).toBeGreaterThan(0); // never frozen
  });
});

describe("CEO desk cluster (wi-anim-round3 position fix)", () => {
  const deskSlots = Array.from({ length: DESK_COUNT }, (_, i) => deskSlot(i));
  const deskTiles = Array.from({ length: DESK_COUNT }, (_, i) => deskFootprint(i));

  it("the CEO sits on the exec chair decor tile, not in the desk rows", () => {
    const chairDecor = DECOR.find((d) => d.frame.startsWith("chair_exec"));
    expect(chairDecor?.at).toEqual(CEO_CHAIR);
    const deskDecor = DECOR.find((d) => d.frame.startsWith("ceo_desk"));
    expect(deskDecor?.at).toEqual(CEO_DESK);
  });

  it("CEO chair and PM spot never collide with worker desk slots (the reported bug)", () => {
    for (const spot of [CEO_CHAIR, CEO_SPOT]) {
      for (const s of [...deskSlots, ...deskTiles]) {
        expect(dist(spot, s)).toBeGreaterThan(0.6);
      }
    }
  });

  it("queue slots line up in front of the CEO desk, clear of desk slots", () => {
    for (const q of CEO_QUEUE_SLOTS) {
      expect(q.gy).toBeGreaterThan(CEO_DESK.gy); // in front (down-screen)
      for (const s of [...deskSlots, ...deskTiles]) {
        expect(dist(q, s)).toBeGreaterThan(0.6);
      }
    }
  });

  it("ceoQueueSlot clamps overflow onto the last slot", () => {
    expect(ceoQueueSlot(0)).toEqual(CEO_QUEUE_SLOTS[0]);
    expect(ceoQueueSlot(99)).toEqual(CEO_QUEUE_SLOTS[CEO_QUEUE_SLOTS.length - 1]);
  });
});
