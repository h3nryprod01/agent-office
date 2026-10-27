// The floor plan is data so these can catch what used to need a screenshot:
// furniture through a wall, two props in one spot, an agent sent into a desk.
import { describe, expect, it } from "vitest";
import {
  CEO_SPOTS, DESK_COLS, DESK_ROWS, ENTRANCE, crosses, decorFootprints, deskStand, GREET_SPOT, HX, HZ, LAMPS, STATION_SLOTS, ceoLineSlot, footprints, inside, overlaps, type Pt,
} from "../src/render3d/floorplan";

const onFloor = (p: Pt): boolean => Math.abs(p.x) < HX - 0.3 && Math.abs(p.z) < HZ - 0.3;

describe("floor plan", () => {
  const rects = footprints();

  it("keeps every piece of furniture on the floor", () => {
    for (const r of rects) {
      expect(r.x0, r.id).toBeGreaterThanOrEqual(-HX);
      expect(r.x1, r.id).toBeLessThanOrEqual(HX);
      expect(r.z0, r.id).toBeGreaterThanOrEqual(-HZ);
      expect(r.z1, r.id).toBeLessThanOrEqual(HZ);
    }
  });

  it("never puts two pieces of furniture in the same place", () => {
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      expect(overlaps(rects[i], rects[j]), `${rects[i].id} overlaps ${rects[j].id}`).toBe(false);
    }
  });

  it("sends agents only to open floor", () => {
    const spots: [string, Pt][] = [
      ["entrance", ENTRANCE], ["greet", GREET_SPOT],
      ...Object.entries(CEO_SPOTS).map(([k, p]) => [`ceo:${k}`, p] as [string, Pt]),
      ...Object.entries(STATION_SLOTS).flatMap(([k, ps]) => ps.map((p, i) => [`${k}${i}`, p] as [string, Pt])),
      ...Array.from({ length: 30 }, (_, i) => [`queue${i}`, ceoLineSlot(i)] as [string, Pt]),
    ];
    for (const [name, p] of spots) {
      expect(onFloor(p), `${name} off the floor`).toBe(true);
      for (const r of rects) expect(inside(p, r), `${name} is inside ${r.id}`).toBe(false);
    }
  });

  it("keeps lamps out of the furniture", () => {
    for (const [x, z] of LAMPS) for (const r of rects) expect(inside({ x, z }, r), `lamp ${x},${z} in ${r.id}`).toBe(false);
  });

  it("fits each room's set dressing into open floor", () => {
    for (const d of decorFootprints()) {
      expect(d.x1, d.id).toBeLessThanOrEqual(HX);
      expect(d.z1, d.id).toBeLessThanOrEqual(HZ);
      for (const r of rects) expect(overlaps(d, r), `${d.id} overlaps ${r.id}`).toBe(false);
      for (const [x, z] of LAMPS) expect(inside({ x, z }, d), `lamp ${x},${z} in ${d.id}`).toBe(false);
    }
  });

  it("keeps the walk from the lift clear of the furniture around it", () => {
    // agents walk straight lines; walking through desks is how the office always
    // worked, but the lift corner (reception, racks, shelves, CEO desk) must be clear
    const dests: [string, Pt][] = [
      ...DESK_ROWS.flatMap((_, r) => DESK_COLS.map((__, c) => [`desk${r}:${c}`, deskStand(r, c)] as [string, Pt])),
      ...Object.entries(STATION_SLOTS).flatMap(([k, ps]) => ps.map((p, i) => [`${k}${i}`, p] as [string, Pt])),
      ...[0, 1, 2].map((n) => [`greet${n}`, { x: GREET_SPOT.x - n * 1.6, z: GREET_SPOT.z }] as [string, Pt]),
    ];
    const solid = rects.filter((r) => !r.id.startsWith("desk") && !r.id.startsWith("plant") && r.id !== "meeting");
    for (const [name, p] of dests) for (const r of solid) {
      expect(crosses(ENTRANCE, p, r, 0.3), `lift → ${name} brushes ${r.id}`).toBe(false);
    }
  });

  it("crosses() agrees with obvious cases", () => {
    const r = { id: "r", x0: 0, x1: 2, z0: 0, z1: 2 };
    expect(crosses({ x: -1, z: 1 }, { x: 3, z: 1 }, r)).toBe(true);
    expect(crosses({ x: -1, z: 3 }, { x: 3, z: 3 }, r)).toBe(false);
    expect(crosses({ x: -1, z: -1 }, { x: 3, z: 3 }, r)).toBe(true);
  });

  it("has ten work desks plus the CEO desk", () => {
    expect(rects.filter((r) => r.id.startsWith("desk")).length).toBe(10);
    expect(rects.some((r) => r.id === "ceoDesk")).toBe(true);
  });

  it("gives every station room for five agents", () => {
    for (const slots of Object.values(STATION_SLOTS)) expect(slots.length).toBeGreaterThanOrEqual(5);
  });
});
