// Where everything stands — the office floor plan as data.
//
// Pure (no THREE) so the layout can be checked by tests: nothing pokes through a
// wall, no two pieces of furniture overlap, and every spot an agent walks to is
// on open floor. Office3D reads positions from here and only builds the meshes.
//
// The camera sits front-right (+x, +z) looking at the back-left corner, so:
//  - the BACK wall (z = -HZ) and the LEFT wall (x = -HX) are the only walls; they
//    never hide anything, so tall things (shelves, racks, boards, the lift) go on them;
//  - the FRONT strip (high z) only gets low furniture, or it would hide the desks;
//  - the command centre (CEO desk + its queue) sits in the middle of the back wall,
//    the first place the eye lands.
//
// Zones, back wall left→right: library · work board · CEO desk · spend board ·
// window · lift + reception. Left wall back→front: LLM provider racks · arcade ·
// outputs cabinet · lounge. Open floor: two rows of desks, meeting table front-left,
// the room's own set dressing front-right.

export const FLOOR_W = 44;
export const FLOOR_D = 34;
export const HX = FLOOR_W / 2; // 22
export const HZ = FLOOR_D / 2; // 17
export const WALL_H = 5.8;

export interface Pt { x: number; z: number }
/** an axis-aligned footprint on the floor, for the overlap checks */
export interface Rect { id: string; x0: number; x1: number; z0: number; z1: number }
const rect = (id: string, cx: number, cz: number, w: number, d: number): Rect =>
  ({ id, x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 });

// ── back wall ──
export const BOARD_WORK = { x: -5.6, w: 9.6, h: 5 };
export const BOARD_SPEND = { x: 6.2, w: 6.8, h: 5 };
export const LIBRARY = [{ x: -18.6, z: -16.3 }, { x: -15, z: -16.3 }] as const; // two shelves, 3.4 wide
export const WINDOW_BACK = { x: 13.2, w: 3.6, y: 3.2, h: 3 };
export const LIFT = { x: 18.8, w: 3.4, h: 4.2 };
export const RECEPTION = { x: 20.2, z: -12, w: 3.4, d: 1.1 }; // right of the lift: out of every path that leaves it
export const CEO_DESK = { x: 0, z: -12.2 };

// ── left wall ──
/** one rack per vendor family, back → front */
export const RACK_FAMILIES = ["claude", "codex", "gemini", "claude-worker", "hermes"] as const;
export const RACKS = RACK_FAMILIES.map((family, i) => ({ family, x: -21.25, z: -15.4 + i * 1.6 }));
export const ARCADES = [{ x: -21.1, z: -4 }, { x: -21.1, z: -1.6 }] as const;
export const CABINET = { x: -21, z: 2.8 };
export const SOFA = { x: -20.6, z: 8.6 };
export const WINDOW_LEFT = { z: 8.6, w: 5, y: 3.4, h: 2.6 };
/** the band of left wall above the arcade, where each room hangs its own decor */
export const LEFT_WALL_DECOR = { z: -2.8, y: 4 };

// ── open floor ──
export const DESK_COLS = [-8, -2, 4, 10, 16] as const;
export const DESK_ROWS = [-4.6, 4.6] as const;
/** desk-group local footprint: partition at -1.55 … desk front at +1.2 */
const DESK_Z0 = -1.6, DESK_Z1 = 1.25, DESK_W = 6;
export const MEET_CENTER = { x: -11, z: 11.2 };
export const MEET_R = 1.45;

// ── where agents go ──
export const ENTRANCE: Pt = { x: LIFT.x, z: -15.4 }; // they arrive by the lift
export const GREET_SPOT: Pt = { x: 17.6, z: -10.6 }; // new hires wait by reception (Office3D lines them up leftwards)
/** facing (rotation.y) at each station: shelf → the books, arcade → the cabinet */
export const STATION_FACE = { bookshelf: Math.PI, arcade: -Math.PI / 2 } as const;
export const STATION_SLOTS: Record<"bookshelf" | "arcade" | "meeting", Pt[]> = {
  bookshelf: [{ x: -19.4, z: -14.5 }, { x: -17.8, z: -14.5 }, { x: -16.2, z: -14.5 }, { x: -14.6, z: -14.5 }, { x: -17, z: -13.1 }],
  arcade: [{ x: -19.6, z: -4 }, { x: -19.6, z: -1.6 }, { x: -18.3, z: -4 }, { x: -18.3, z: -1.6 }, { x: -19.6, z: 0.2 }],
  // the far side of the meeting table, so a stand-up and a delegation don't overlap
  meeting: [0, 1, 2, 3, 4].map((k) => {
    const ang = Math.PI + (k - 2) * 0.42;
    return { x: MEET_CENTER.x + Math.sin(ang) * 2.5, z: MEET_CENTER.z + Math.cos(ang) * 2.5 };
  }),
};
/** the CEO decision line: a physical FIFO queue in front of the CEO desk */
export const ceoLineSlot = (i: number): Pt => ({ x: -2.4 + (i % 5) * 1.2, z: -9.2 + (Math.floor(i / 5) % 2) * 1.1 }); // two rows, then they double up
/** where the CEO avatar (you) drifts to between decisions — keys match render/ceoActivity */
export const CEO_SPOTS = {
  desk: { x: 1.8, z: -10.6 },
  cooler: { x: -11.4, z: -14.6 },
  sofa: { x: -18.8, z: 8.6 },
  window: { x: WINDOW_BACK.x, z: -15.4 },
  phone: { x: 19.6, z: -9.6 },
  board: { x: -5.6, z: -15.5 },
} as const;

// ── each room's own set dressing (rooms.ts), in the open front strip — low pieces only ──
export const STUDIO_SET = { x: 16, z: 11 }; // backdrop + softboxes + camera
export const MAQUETTE = { x: 5, z: 11.6 };
export const BROCHURES = { x: 19.2, z: 12 };
export const BEANBAGS = [{ x: -18.4, z: 12.4 }, { x: -16.8, z: 13.6 }] as const;

export const LAMPS: readonly (readonly [number, number, number])[] = [
  [-13.5, 0, 0], [-5, 0, 0], [1, 0, 0], [7, 0, 0], [13, 0, 0], [19.2, 0, 0],
  [-5.5, 12.8, 0.4], [9.6, 14.6, -0.3],
];
export const PLANTS: readonly (readonly [number, number, number])[] = [
  [-20.6, 15.6, 1], [20.6, 15.6, 1], [20.6, -6.8, 0.9], [20.8, 4, 1.05], [0.5, 15.8, 1], [-12, -16.1, 0.8], [10, -16.1, 0.8],
];

/** every footprint the overlap test checks; desks come from the grid */
export function footprints(): Rect[] {
  const out: Rect[] = [
    ...LIBRARY.map((s, i) => rect(`library${i}`, s.x, s.z, 3.4, 0.6)),
    rect("lift", LIFT.x, -16.6, LIFT.w + 0.6, 0.8),
    rect("reception", RECEPTION.x, RECEPTION.z, RECEPTION.w, RECEPTION.d),
    rect("ceoDesk", CEO_DESK.x, CEO_DESK.z - 0.05, 3.7, 2.6), // desk + chair
    ...RACKS.map((r) => rect(`rack:${r.family}`, r.x, r.z, 1.1, 1.4)),
    ...ARCADES.map((a, i) => rect(`arcade${i}`, a.x, a.z, 1.0, 1.6)),
    rect("cabinet", CABINET.x, CABINET.z, 1.1, 1.5),
    rect("sofa", SOFA.x, SOFA.z, 1.3, 3.5),
    rect("meeting", MEET_CENTER.x, MEET_CENTER.z, MEET_R * 2, MEET_R * 2),
    ...PLANTS.map(([x, z, s], i) => rect(`plant${i}`, x, z, 0.8 * s, 0.8 * s)),
  ];
  DESK_ROWS.forEach((z, r) => DESK_COLS.forEach((x, c) => out.push({ id: `desk${r}:${c}`, x0: x - DESK_W / 2, x1: x + DESK_W / 2, z0: z + DESK_Z0, z1: z + DESK_Z1 })));
  return out;
}

/** the room-specific pieces; each must clear the shared furniture (they never coexist with each other) */
export function decorFootprints(): Rect[] {
  return [
    rect("studioSet", STUDIO_SET.x, STUDIO_SET.z + 1.2, 8.2, 5.4),
    rect("maquette", MAQUETTE.x, MAQUETTE.z, 6.2, 3.8),
    rect("brochures", BROCHURES.x, BROCHURES.z, 1.6, 0.5),
    ...BEANBAGS.map((b, i) => rect(`beanbag${i}`, b.x, b.z, 1.5, 1.5)),
  ];
}

/** where an agent stands to work at desk (row, col) — Office3D.seatStand, same offset */
export const deskStand = (row: number, col: number): Pt => ({ x: DESK_COLS[col], z: DESK_ROWS[row] - 0.55 });

/** does the straight walk from a to b pass through r? (agents walk straight lines, no pathfinding) */
export function crosses(a: Pt, b: Pt, r: Rect): boolean {
  // Liang–Barsky clip of the segment against the rectangle
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  const edges: [number, number][] = [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dz, a.z - r.z0], [dz, r.z1 - a.z]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const tt = q / p;
    if (p < 0) { if (tt > t1) return false; if (tt > t0) t0 = tt; } else { if (tt < t0) return false; if (tt < t1) t1 = tt; }
  }
  return t0 < t1;
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
export const inside = (p: Pt, r: Rect): boolean => p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1;
