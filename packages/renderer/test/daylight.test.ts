import { describe, expect, it } from "vitest";
import { daylightAt, hourOf } from "../src/render3d/daylight";

describe("daylightAt", () => {
  it("is brighter at noon than at midnight", () => {
    const noon = daylightAt(12), mid = daylightAt(0);
    expect(noon.sunIntensity).toBeGreaterThan(mid.sunIntensity);
    expect(noon.ambientIntensity).toBeGreaterThan(mid.ambientIntensity);
    expect(noon.night).toBe(0);
    expect(mid.night).toBe(1);
  });

  it("never plunges the room into the dark: the darkest hour is still readable", () => {
    // The "Lights off" button (Office3D.setNight) sets ambient 0.1 — a natural
    // night must stay well above that or the office is unreadable at 11pm.
    for (let h = 0; h < 24; h += 0.25) {
      const d = daylightAt(h);
      expect(d.ambientIntensity).toBeGreaterThanOrEqual(0.3);
      expect(d.sunIntensity).toBeGreaterThanOrEqual(0.25);
    }
  });

  it("changes smoothly: no hour-to-hour jump big enough to read as a flash", () => {
    let prev = daylightAt(0);
    for (let h = 0.05; h <= 24; h += 0.05) {
      const d = daylightAt(h);
      expect(Math.abs(d.sunIntensity - prev.sunIntensity)).toBeLessThan(0.06);
      expect(Math.abs(d.ambientIntensity - prev.ambientIntensity)).toBeLessThan(0.03);
      prev = d;
    }
  });

  it("wraps the clock: 24 is midnight, negatives and overshoot normalise", () => {
    expect(daylightAt(24).sunIntensity).toBeCloseTo(daylightAt(0).sunIntensity, 5);
    expect(daylightAt(25).hour).toBeCloseTo(1, 5);
    expect(daylightAt(-1).hour).toBeCloseTo(23, 5);
  });

  it("keeps the key light above the floor and on the camera's side", () => {
    for (let h = 0; h < 24; h += 0.25) {
      const [, y, z] = daylightAt(h).sunPos;
      expect(y).toBeGreaterThan(4);
      expect(z).toBeGreaterThan(0);
    }
  });

  it("swings the sun across the sky between sunrise and sunset", () => {
    expect(daylightAt(7).sunPos[0]).toBeGreaterThan(daylightAt(17).sunPos[0]);
  });

  it("warms the light at the edges of the day", () => {
    const red = (c: number): number => (c >> 16) & 255, blue = (c: number): number => c & 255;
    const dawn = daylightAt(6.5), noon = daylightAt(12);
    expect(red(dawn.sunColor) / blue(dawn.sunColor)).toBeGreaterThan(red(noon.sunColor) / blue(noon.sunColor));
  });

  it("hourOf reads fractional local hours", () => {
    expect(hourOf(new Date(2026, 0, 1, 13, 30, 0))).toBeCloseTo(13.5, 5);
  });
});
