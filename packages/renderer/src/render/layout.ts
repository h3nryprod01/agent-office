import { t } from "../i18n";
import type { StationId } from "../sim/model";
import type { GridPos } from "./iso";

/**
 * Office floor plan on a GRID_SIZE x GRID_SIZE tile grid.
 * Placeholder geometry only — when real art lands, each station keeps its
 * grid footprint and just swaps its drawing (see OfficeView.drawStation).
 */
export const GRID_SIZE = 14;

export interface StationDef {
  id: StationId;
  label: string;
  color: number;
  /** Tiles occupied by the furniture itself. */
  footprint: GridPos[];
  /** Standing slots for characters using the station. */
  slots: GridPos[];
}

/** Door: where root agents walk in from. */
export const DOOR: GridPos = { gx: 0, gy: 7 };

/** Desks: one per character, assigned by spawn order (2 columns x 8 rows). */
export const DESK_COUNT = 16;

export function deskFootprint(index: number): GridPos {
  const col = index % 2;
  const row = Math.floor(index / 2) % 8;
  return { gx: 4 + col * 3, gy: 2 + row * 1.5 };
}

/** Where a character stands when working at desk `index`. */
export function deskSlot(index: number): GridPos {
  const desk = deskFootprint(index);
  return { gx: desk.gx - 0.9, gy: desk.gy };
}

/**
 * Purely decorative items (no slots, no station logic). Drawn only when the
 * tileset atlas loaded — placeholder mode skips them entirely. Frames come
 * from art round 2 (assets/spritesheets/office-tileset.json).
 */
export interface DecorDef {
  frame: string;
  at: GridPos;
  label?: string;
  /** Present → the sprite is clickable (OfficeView.onFurnitureClick fires with this id). */
  id?: string;
}

/**
 * CEO desk cluster — SINGLE source of truth (wi-anim-round3 root-cause fix).
 * The decor furniture (DECOR below), the seated CEO, the pinned PM, and the
 * approval queue all derive from these; nothing else may hardcode them.
 * (The old CEO_CHAIR {3.1, 2.2} sat the CEO on top of desk 0's worker slot.)
 */
export const CEO_DESK: GridPos = { gx: 2.4, gy: 1.5 };

/** The exec chair tile — the CEO (you) sits exactly here. */
export const CEO_CHAIR: GridPos = { gx: 1.5, gy: 2.4 };

/** Where the pinned PM character stands, beside the desk. */
export const CEO_SPOT: GridPos = { gx: 1.5, gy: 1.5 };

/**
 * Line where agents wait on a CEO decision (wi-ceo-avatar spec), in front of
 * the CEO desk: index 0 = front of line. Kept west of the regular desk-slot
 * column (gx 3.1) so the queue never stands on working agents. More agents
 * than slots crowd onto the last one ("đứng dồn").
 */
export const CEO_QUEUE_SLOTS: GridPos[] = Array.from({ length: 5 }, (_, i) => ({
  gx: CEO_DESK.gx - 0.2,
  gy: CEO_DESK.gy + 1.7 + i * 1.2,
}));

/** Where the agent at queue position `index` (0 = front) stands. */
export function ceoQueueSlot(index: number): GridPos {
  return CEO_QUEUE_SLOTS[Math.min(index, CEO_QUEUE_SLOTS.length - 1)];
}

/**
 * Hiring Hall (wi-hiring-hall): reception desk just inside the door, on the
 * free strip between the CEO queue (gy≤8) and the lounge (gy≥11). Clicking
 * it opens the recruitment panel.
 */
export const RECEPTION_DESK: GridPos = { gx: 2.2, gy: 10.3 };

/** Where a walk-in greeter (new roster member) stops to say hi — open floor
 * SE of the desk, clear of the NW velocity wall board's z-boosted overlap. */
export const RECEPTION_GREET_SPOT: GridPos = { gx: 3.4, gy: 10.6 };

export const DECOR: DecorDef[] = [
  { frame: "ceo_desk_E", at: CEO_DESK, label: t("station.pmDesk") },
  { frame: "chair_exec_E", at: CEO_CHAIR },
  { frame: "plant_big", at: { gx: 0.6, gy: 0.6 } },
  { frame: "neon_sign", at: { gx: 3.2, gy: 0.3 } },
  // lounge (round 3: rug under the sofa cluster)
  { frame: "rug_big", at: { gx: 2, gy: 12 } },
  { frame: "sofa", at: { gx: 1, gy: 11 } },
  { frame: "coffee_table", at: { gx: 2, gy: 12 } },
  { frame: "plant", at: { gx: 0.6, gy: 12 } },
  // round 3 props — fill the empty east/south floor without adding desks
  { frame: "water_cooler", at: { gx: 8.5, gy: 0.6 } },
  // wi-office-life: beside the bookshelf station (gx11-12, gy1) — click opens
  // the outputs panel ("tủ hồ sơ", GET /outputs)
  { frame: "filing_cabinet", at: { gx: 13, gy: 1 }, label: t("station.cabinet"), id: "filing_cabinet" },
  { frame: "server_rack", at: { gx: 13.2, gy: 3.2 }, label: "Server" },
  { frame: "plant_big", at: { gx: 13.2, gy: 9 } },
  // wall-mounted decor (on the NE back wall, gy≈0 → sorts behind the room)
  { frame: "wall_clock_NE", at: { gx: 8, gy: 0.15 } },
  { frame: "poster_NE", at: { gx: 12, gy: 0.15 } },
];

/**
 * Live data boards on the back wall (wi-office-makeover). `kind` picks the
 * data source; OfficeView builds a WallBoardView per entry and main.ts pushes
 * refreshed snapshots into it. Placed on the NE wall (gy≈0) between props.
 */
export interface WallBoardDef {
  frame: string;
  at: GridPos;
  kind: "scrum" | "velocity";
}

export const WALL_BOARDS: WallBoardDef[] = [
  // Boards lie flat on their wall plane (wi-pm-ux: WallBoardView skews to the
  // wall slope, ±TILE_H/TILE_W). A board spans ~±1.9 tiles along its wall, so
  // each sits in a free wall stretch: scrum on the NE wall between the window
  // (gx2) and the clock (gx8); velocity on the NW wall past the door (gy7),
  // clear of the window (gy3). Frame suffix must match the wall side.
  { frame: "wall_board_NE", at: { gx: 5.5, gy: 0.15 }, kind: "scrum" },
  { frame: "wall_board_NW", at: { gx: 0.15, gy: 10.5 }, kind: "velocity" },
];

export const STATIONS: StationDef[] = [
  {
    id: "bookshelf",
    label: t("station.bookshelf"),
    color: 0x8b5cf6,
    footprint: [
      { gx: 11, gy: 1 },
      { gx: 12, gy: 1 },
    ],
    slots: [
      { gx: 11, gy: 2.2 },
      { gx: 12, gy: 2.2 },
      { gx: 10.2, gy: 2.6 },
      { gx: 12.8, gy: 2.6 },
    ],
  },
  {
    id: "arcade",
    label: t("station.arcade"),
    color: 0x06b6d4,
    footprint: [
      { gx: 11.5, gy: 6 },
      { gx: 12.5, gy: 6 },
    ],
    slots: [
      { gx: 11.5, gy: 7.2 },
      { gx: 12.5, gy: 7.2 },
      { gx: 10.7, gy: 7.6 },
      { gx: 13, gy: 7.6 },
    ],
  },
  {
    id: "meeting",
    label: t("station.meeting"),
    color: 0xf59e0b,
    footprint: [
      { gx: 11, gy: 10.5 },
      { gx: 12, gy: 10.5 },
      { gx: 11, gy: 11.5 },
      { gx: 12, gy: 11.5 },
    ],
    slots: [
      { gx: 10, gy: 10 },
      { gx: 13, gy: 10 },
      { gx: 10, gy: 12 },
      { gx: 13, gy: 12 },
      { gx: 11.5, gy: 9.3 },
      { gx: 11.5, gy: 12.7 },
    ],
  },
];

const stationById = new Map(STATIONS.map((s) => [s.id, s]));

/**
 * Resolve where agent `agentSlot` (stable per-agent number) stands for a
 * given station. "desk" is per-agent; shared stations hand out slots
 * round-robin so characters don't stack on one tile.
 */
export function standingPosition(station: StationId, agentSlot: number): GridPos {
  if (station === "desk") return deskSlot(agentSlot % DESK_COUNT);
  const def = stationById.get(station);
  if (!def) return deskSlot(agentSlot % DESK_COUNT);
  return def.slots[agentSlot % def.slots.length];
}
