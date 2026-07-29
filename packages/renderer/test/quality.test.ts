// The quality watchdog decides when to drop shadows on a machine that can't keep
// up. It was inline in main.ts's rAF loop, where it could not be tested — rAF
// doesn't run in a test environment, and it barely runs in a headless browser
// either, so "I checked it in the browser" was not available. Pulling the rule
// out made it checkable; these are the cases that actually matter.

import { describe, expect, it } from "vitest";
import { LOW_FPS, SLOW_MS, initialQuality, watchQuality } from "../src/render3d/quality";

/** feed a run of identical samples, 500ms apart, like the render loop does */
function feed(fps: number, forMs: number, from = 1_000) {
  let state = initialQuality();
  let degradedAt: number | null = null;
  for (let t = from; t <= from + forMs; t += 500) {
    const r = watchQuality(state, fps, t);
    state = r.state;
    if (r.degrade && degradedAt === null) degradedAt = t;
  }
  return { state, degradedAt };
}

describe("quality watchdog", () => {
  it("leaves a healthy machine alone", () => {
    const { state, degradedAt } = feed(60, 30_000);
    expect(degradedAt).toBeNull();
    expect(state.degraded).toBe(false);
  });

  it("ignores a brief stall — a GC pause must not cost you shadows forever", () => {
    let state = initialQuality();
    // slow for 2s (less than SLOW_MS), then recovers
    for (let t = 1_000; t < 3_000; t += 500) state = watchQuality(state, 5, t).state;
    const recovered = watchQuality(state, 60, 3_000);
    expect(recovered.degrade).toBe(false);
    expect(recovered.state.slowSince).toBe(0); // streak reset
    // ...and a later slow patch starts its clock fresh, not from the old streak
    const later = watchQuality(recovered.state, 5, 3_500);
    expect(later.degrade).toBe(false);
    expect(later.state.slowSince).toBe(3_500);
  });

  it("degrades once a slow streak outlasts SLOW_MS", () => {
    const { state, degradedAt } = feed(3, 10_000); // the 3 fps measured in the VM
    expect(state.degraded).toBe(true);
    expect(degradedAt).toBe(1_000 + SLOW_MS);
  });

  it("fires exactly once — quality never flaps", () => {
    let state = initialQuality();
    let fires = 0;
    for (let t = 1_000; t < 60_000; t += 500) {
      const r = watchQuality(state, 3, t);
      state = r.state;
      if (r.degrade) fires++;
    }
    expect(fires).toBe(1);
  });

  it("stays degraded even if the machine speeds up afterwards", () => {
    const { state } = feed(3, 10_000);
    const after = watchQuality(state, 144, 99_000);
    expect(after.degrade).toBe(false);
    expect(after.state.degraded).toBe(true); // one-way by design
  });

  it("treats exactly LOW_FPS as fast enough", () => {
    const { degradedAt } = feed(LOW_FPS, 30_000);
    expect(degradedAt).toBeNull();
  });

  it("treats just under LOW_FPS as slow", () => {
    const { state } = feed(LOW_FPS - 1, 10_000);
    expect(state.degraded).toBe(true);
  });

  // A hidden tab gets its rAF throttled, so fps reads ~0 on any machine. This
  // fired for real: the office lost its shadows for good because the page was in
  // the background, and the downgrade is one-way — only a reload brings them back.
  it("ignores a backgrounded tab, however long it sits there", () => {
    let state = initialQuality();
    let fires = 0;
    for (let t = 1_000; t < 60_000; t += 500) {
      const r = watchQuality(state, 0, t, false); // hidden the whole time
      state = r.state;
      if (r.degrade) fires++;
    }
    expect(fires).toBe(0);
    expect(state.degraded).toBe(false);
  });

  it("does not carry a hidden streak over into a visible one", () => {
    let state = initialQuality();
    for (let t = 1_000; t < 9_000; t += 500) state = watchQuality(state, 0, t, false).state;
    // back in front, still slow: the clock starts now, not 8s ago
    const first = watchQuality(state, 3, 9_000, true);
    expect(first.degrade).toBe(false);
    expect(first.state.slowSince).toBe(9_000);
  });

  it("still degrades a genuinely slow machine that is visible", () => {
    let state = initialQuality();
    let degraded = false;
    for (let t = 1_000; t <= 9_000; t += 500) {
      const r = watchQuality(state, 3, t, true);
      state = r.state;
      degraded ||= r.degrade;
    }
    expect(degraded).toBe(true);
  });
});
