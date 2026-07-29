// Pure data shaping for the office wall boards (wi-office-makeover). No PixiJS
// import here so it unit-tests in node — the Pixi view lives in
// render/wallBoards.ts and imports from this module.

import type { WorkItem } from "./workItems";

/** Snapshot pushed to every visible office; null field = unavailable. */
export interface WallBoardData {
  scrum: ScrumSummary | null;
  velocityUsd: number | null;
}

export interface ScrumSummary {
  todo: number;
  inProgress: number;
  done: number;
  /** A few in-progress titles to show under the counts. */
  titles: string[];
}

/**
 * Bucket the registry into the three Scrum columns. `in_progress`/`blocked`
 * → In Progress, `done` → Done, everything else (backlog, unknown) → To Do.
 */
export function scrumSummary(items: WorkItem[], maxTitles = 3): ScrumSummary {
  let todo = 0;
  let inProgress = 0;
  let done = 0;
  const titles: string[] = [];
  for (const it of items) {
    const s = it.status ?? "";
    if (s === "done") done++;
    else if (s === "in_progress" || s === "blocked") {
      inProgress++;
      if (titles.length < maxTitles) titles.push(it.title);
    } else todo++;
  }
  return { todo, inProgress, done, titles };
}
