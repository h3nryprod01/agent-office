/** Pure CEO idle-flavor logic (wi-office-life) — no Pixi imports, same reasoning as anim.ts. */

import type { GridPos } from "./iso";
import { CEO_CHAIR } from "./layout";

/** "desk" is the working baseline (typing); the rest are occasional flavor while nobody needs a decision. */
export type CeoActivity = "desk" | "cooler" | "sofa" | "window" | "phone" | "board";

const ACTIVITY_POOL: readonly CeoActivity[] = ["desk", "cooler", "sofa", "window", "phone", "board"];

/** Where the CEO stands for each activity — "phone" is a held pose at the desk, not a walk. */
export const CEO_ACTIVITY_SPOT: Record<CeoActivity, GridPos> = {
  desk: CEO_CHAIR,
  phone: CEO_CHAIR,
  cooler: { gx: 8.5, gy: 1.5 }, // in front of the water_cooler decor
  sofa: { gx: 1.5, gy: 11 }, // the lounge cluster
  window: { gx: 2, gy: 0.8 }, // one of the NE wall windows
  board: { gx: 5.5, gy: 1.2 }, // facing the scrum wall board
};

/** Roll the CEO's next idle flavor. `rand` in [0,1) — Math.random() live, fixed values in tests. */
export function pickCeoActivity(rand: number): CeoActivity {
  const i = Math.min(ACTIVITY_POOL.length - 1, Math.floor(rand * ACTIVITY_POOL.length));
  return ACTIVITY_POOL[i];
}

/** Gap until the next roll: 6-18s (rand in [0,1)) — CEO wanders ~3x more often. */
export function ceoActivityDelay(rand: number): number {
  return 6_000 + rand * 12_000;
}

/**
 * What the CEO should be doing right now. `blocked` (someone's waiting on a
 * decision, or any agent is alerting) always wins — straight back to the
 * desk, no more wandering, so the CEO never stands in front of / on top of
 * whoever needs attention. Otherwise keep the current flavor until
 * `changeDue`, then roll a new one.
 */
export function nextCeoActivity(
  current: CeoActivity,
  blocked: boolean,
  changeDue: boolean,
  rand: () => number,
): CeoActivity {
  if (blocked) return "desk";
  if (!changeDue) return current;
  return pickCeoActivity(rand());
}
