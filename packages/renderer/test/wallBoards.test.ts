import { describe, expect, it } from "vitest";
import { scrumSummary } from "../src/ui/wallBoardData";
import type { WorkItem } from "../src/ui/workItems";

const item = (status: string | null, title = "t"): WorkItem => ({ id: title, title, status });

describe("scrumSummary", () => {
  it("buckets statuses into To Do / In Progress / Done", () => {
    const s = scrumSummary([
      item("done"),
      item("done"),
      item("in_progress"),
      item("blocked"),
      item("backlog"),
      item(null),
    ]);
    expect(s.done).toBe(2);
    expect(s.inProgress).toBe(2); // in_progress + blocked
    expect(s.todo).toBe(2); // backlog + null
  });

  it("collects up to maxTitles in-progress titles", () => {
    const items = [item("in_progress", "a"), item("in_progress", "b"), item("in_progress", "c"), item("in_progress", "d")];
    expect(scrumSummary(items, 2).titles).toEqual(["a", "b"]);
  });

  it("is empty for an empty registry", () => {
    expect(scrumSummary([])).toEqual({ todo: 0, inProgress: 0, done: 0, titles: [] });
  });
});
