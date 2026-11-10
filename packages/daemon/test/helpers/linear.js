// Timing assertions that do not flake on a slow CI runner: compare the SAME code at 10k and 100k characters
// (linear ~10x, quadratic ~100x) using the best of three runs, plus a very loose absolute ceiling.
import assert from "node:assert/strict";

const best = (fn, runs = 3) => {
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    b = Math.min(b, performance.now() - t0);
  }
  return b;
};

/** @param {(n: number) => string} make a text of about n characters @param {(text: string) => unknown} run */
export function assertLinear(label, make, run) {
  const small = make(10_000);
  const big = make(100_000);
  run(small); // warm up
  const t10 = Math.max(best(() => run(small)), 0.3); // a floor, so a sub-millisecond run does not make the ratio meaningless
  const t100 = best(() => run(big));
  assert.ok(t100 < 1000, `${label}: ${t100.toFixed(0)} ms for 100k characters`);
  assert.ok(t100 < 40 * t10, `${label}: 100k took ${t100.toFixed(1)} ms vs ${t10.toFixed(1)} ms for 10k (ratio ${(t100 / t10).toFixed(0)}x, linear is ~10x)`);
}
