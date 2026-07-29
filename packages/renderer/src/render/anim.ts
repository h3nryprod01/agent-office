/** Pure animation math — no Pixi imports so it stays unit-testable. */

/** Symmetric ease-in-out for walk tweens (accelerate, cruise, settle). */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Overshoot pop used by the spawn effect. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Grid-diagonal movement (dx, dy) → the nearest of the 4 sprite-sheet walk directions. */
export function walkDirection(dx: number, dy: number): "N" | "E" | "S" | "W" {
  // screen axes: +gx moves screen-right/down, +gy moves screen-left/down (see iso.ts)
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "E" : "W";
  return dy > 0 ? "S" : "N";
}

/** Per-channel RGB lerp for the status badge color transition. */
export function lerpColor(from: number, to: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(((from >> 16) & 0xff) + (((to >> 16) & 0xff) - ((from >> 16) & 0xff)) * k);
  const g = Math.round(((from >> 8) & 0xff) + (((to >> 8) & 0xff) - ((from >> 8) & 0xff)) * k);
  const b = Math.round((from & 0xff) + ((to & 0xff) - (from & 0xff)) * k);
  return (r << 16) | (g << 8) | b;
}

/** Time until the next idle fidget (blink / glance): 3–8s, `rand` ∈ [0,1). */
export function fidgetDelay(rand: number): number {
  return 3000 + rand * 5000;
}

/**
 * Typing has a human rhythm: ~1.1s burst, ~0.5s pause. Returns the
 * AnimatedSprite.animationSpeed for wall-clock `tMs` (offset per agent so
 * the room never types in unison).
 */
export function typingRhythm(tMs: number): number {
  return tMs % 1600 < 1100 ? 0.2 : 0.02;
}
