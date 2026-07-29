/** Isometric grid math. One tile = TILE_W x TILE_H px diamond. */

export const TILE_W = 64;
export const TILE_H = 32;

export interface GridPos {
  gx: number;
  gy: number;
}

export interface ScreenPos {
  x: number;
  y: number;
}

/** Grid coords (can be fractional, for smooth walking) → screen px. */
export function isoToScreen(gx: number, gy: number): ScreenPos {
  return {
    x: ((gx - gy) * TILE_W) / 2,
    y: ((gx + gy) * TILE_H) / 2,
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(a: GridPos, b: GridPos): number {
  return Math.hypot(a.gx - b.gx, a.gy - b.gy);
}
