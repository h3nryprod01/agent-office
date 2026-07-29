// Contract tests for the character kit (src/render3d/robotKit.ts).
//
// Why these exist: robotKit ships the ONLY character in the office, and its
// contract lives in prose at the top of the file — prose can't fail CI. The
// blocky design already shipped too short once and its head hid behind the desk
// monitor; that class of bug is invisible in a diff and obvious in an assert.
//
// No WebGL needed: builders only construct geometry/materials, so this runs in
// the default vitest environment.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CHOSEN, ROBOTS, SKINS, chosenBuilder } from "../src/render3d/robotKit";

/**
 * The desk monitor occupies y≈1.47..2.49 (Office3D.makeSeat puts a 1.02-tall
 * frame at y=1.98). A character sitting at a desk is BEHIND that screen from the
 * camera, so anything shorter than this is simply not visible at work.
 */
const MONITOR_TOP = 2.49;

/** every face feature is drawn in this one colour (robotKit.drawFace INK) */
const INK = 0x0d1117;

function boundsOf(inner: THREE.Object3D): { minY: number; maxY: number } {
  const b = new THREE.Box3().setFromObject(inner);
  return { minY: b.min.y, maxY: b.max.y };
}

/** WCAG relative luminance from an sRGB hex (not THREE.Color — that linearises) */
function luminance(hex: number): number {
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan((hex >> 16) & 255) + 0.7152 * chan((hex >> 8) & 255) + 0.0722 * chan(hex & 255);
}
function contrastRatio(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("robotKit — every design", () => {
  it.each(ROBOTS.map((r) => [r.id, r] as const))("%s builds a usable rig", (_id, r) => {
    const built = r.build(SKINS[0]);
    expect(built.inner.children.length).toBeGreaterThan(0);
    // stepChar swings legs alternately (i % 2), so a lone leg would limp forever
    expect(built.legs.length === 0 || built.legs.length % 2 === 0).toBe(true);
  });

  it.each(ROBOTS.map((r) => [r.id, r] as const))("%s stands or floats deliberately", (_id, r) => {
    const built = r.build(SKINS[0]);
    const { minY } = boundsOf(built.inner);
    if (built.legs.length > 0) {
      expect(minY).toBeCloseTo(0, 1); // legs mean it walks the floor
    } else {
      expect(minY).toBeGreaterThan(1); // no legs means it hovers, on purpose
    }
  });

  it("every design is colour-driven by the skin, not hard-coded", () => {
    // two different skins must produce different materials, or the skin system is a lie
    const a = ROBOTS[0].build(SKINS[0]);
    const b = ROBOTS[0].build(SKINS[3]);
    const colours = (o: THREE.Object3D): string[] => {
      const out: string[] = [];
      o.traverse((n) => {
        const m = (n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (m && "color" in m) out.push(m.color.getHexString());
      });
      return out;
    };
    expect(colours(a.inner)).not.toEqual(colours(b.inner));
  });
});

describe("robotKit — the shipped character", () => {
  it("is the screen-head design", () => {
    expect(CHOSEN).toBe("screen");
    expect(ROBOTS.find((r) => r.id === CHOSEN)).toBeDefined();
  });

  it("clears the desk monitor, so the agent is visible while working", () => {
    const { maxY, minY } = boundsOf(chosenBuilder(SKINS[0]).inner);
    expect(maxY).toBeGreaterThan(MONITOR_TOP);
    expect(minY).toBeCloseTo(0, 1);
  });

  it("exposes its face plate so the office can draw a status on it", () => {
    // Office3D.attachFace() finds the plate via this exact key
    expect(chosenBuilder(SKINS[0]).inner.userData.face).toBeDefined();
  });

  it("walks on a pair of legs", () => {
    expect(chosenBuilder(SKINS[0]).legs.length).toBe(2);
  });
});

describe("robotKit — skins", () => {
  it("are distinct and complete", () => {
    const ids = SKINS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SKINS) {
      expect(s.name.length).toBeGreaterThan(0);
      for (const key of ["body", "accent", "screen"] as const) {
        expect(s[key]).toBeGreaterThanOrEqual(0);
        expect(s[key]).toBeLessThanOrEqual(0xffffff);
      }
    }
  });

  it("keep the face readable: one dark ink on every skin's screen", () => {
    // drawFace() hard-codes INK for all ten skins. If a new skin ships a dark
    // `screen`, the face silently disappears — this is the guard for that.
    for (const s of SKINS) {
      expect(contrastRatio(INK, s.screen), `skin "${s.id}" screen vs face ink`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
