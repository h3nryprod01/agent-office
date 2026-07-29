import { describe, expect, it } from "vitest";
import {
  assignableId,
  COLUMNS,
  columnCards,
  emptyState,
  forTab,
  groupByStatus,
  type KanbanItem,
} from "../src/ui/kanban";

const item = (over: Partial<KanbanItem> & Pick<KanbanItem, "id">): KanbanItem => ({
  title: over.id,
  source: "agent",
  status: "idea",
  ...over,
});

describe("groupByStatus", () => {
  it("groups items into a Map keyed by status", () => {
    const items = [
      item({ id: "1", status: "idea" }),
      item({ id: "2", status: "doing" }),
      item({ id: "3", status: "idea" }),
      item({ id: "4", status: "done" }),
    ];
    const m = groupByStatus(items);
    expect(m.get("idea")?.map((i) => i.id)).toEqual(["1", "3"]);
    expect(m.get("doing")?.map((i) => i.id)).toEqual(["2"]);
    expect(m.get("done")?.map((i) => i.id)).toEqual(["4"]);
    expect(m.get("review")).toBeUndefined();
  });

  it("empty input -> empty Map", () => {
    expect(groupByStatus([]).size).toBe(0);
  });
});

describe("forTab", () => {
  it("mine tab keeps only human items; agent tab keeps only agent items", () => {
    const items = [
      item({ id: "h1", source: "human", status: "idea" }),
      item({ id: "a1", source: "agent", status: "doing" }),
      item({ id: "h2", source: "human", status: "done" }),
      item({ id: "a2", source: "agent", status: "review" }),
    ];
    expect(forTab(items, "mine").map((i) => i.id)).toEqual(["h1", "h2"]);
    expect(forTab(items, "agent").map((i) => i.id)).toEqual(["a1", "a2"]);
  });

  it("a human item never leaks into the agent tab", () => {
    const humanIdea = item({ id: "x", source: "human", status: "idea" });
    expect(forTab([humanIdea], "agent")).toEqual([]);
    expect(forTab([humanIdea], "mine")).toEqual([humanIdea]);
  });
});

describe("columnCards", () => {
  it("non-done columns show every matching card", () => {
    const ideas = Array.from({ length: 5 }, (_, i) =>
      item({ id: `i${i}`, source: "human", status: "idea" }),
    );
    const r = columnCards(ideas, "idea");
    expect(r.shown).toHaveLength(5);
    expect(r.hidden).toBe(0);
  });

  it("done column truncates past 3, reporting the hidden count", () => {
    const done = Array.from({ length: 5 }, (_, i) =>
      item({ id: `d${i}`, source: "agent", status: "done" }),
    );
    const r = columnCards(done, "done");
    expect(r.shown).toHaveLength(3);
    expect(r.hidden).toBe(2);
  });

  it("done column with ≤3 cards does not truncate", () => {
    const done = Array.from({ length: 3 }, (_, i) =>
      item({ id: `d${i}`, source: "agent", status: "done" }),
    );
    const r = columnCards(done, "done");
    expect(r.shown).toHaveLength(3);
    expect(r.hidden).toBe(0);
  });

  it("only matches the requested status", () => {
    const items = [
      item({ id: "a", status: "doing" }),
      item({ id: "b", status: "review" }),
      item({ id: "c", status: "doing" }),
    ];
    expect(columnCards(items, "doing").shown).toHaveLength(2);
    expect(columnCards(items, "review").shown).toHaveLength(1);
  });
});

describe("COLUMNS", () => {
  it("mine = idea + done; agent = idea + doing + review + done", () => {
    expect(COLUMNS.mine.map(([s]) => s)).toEqual(["idea", "done"]);
    expect(COLUMNS.agent.map(([s]) => s)).toEqual(["idea", "doing", "review", "done"]);
  });
});

// #7: an agent item still in "idea" (PM hasn't split it into chip work yet) must
// land in the agent tab's first column "Queued" — not vanish (the old agent
// columns started at "doing", so idea items were counted in the tab badge but
// shown nowhere, reading as "1 thẻ" with an empty board).
describe("agent idea column (#7)", () => {
  it("an agent item status=idea shows in the agent tab's Queued column", () => {
    const agentIdea = item({ id: "wi-building-view", source: "agent", status: "idea" });
    const pool = forTab([agentIdea], "agent");
    expect(pool.map((i) => i.id)).toEqual(["wi-building-view"]);
    const { shown, hidden } = columnCards(pool, "idea");
    expect(shown.map((i) => i.id)).toEqual(["wi-building-view"]);
    expect(hidden).toBe(0);
  });
});

// R13-B-3: a person's idea is "assignable" to the PM — only human+idea gets the
// Giao cho PM button. Agent work and ideas already done/dropped are not.
describe("assignableId (Giao cho PM)", () => {
  it("returns the id for a human idea", () => {
    expect(assignableId(item({ id: "i1", source: "human", status: "idea" }))).toBe("i1");
  });
  it("returns null for an agent idea (no button on chip work)", () => {
    expect(assignableId(item({ id: "a1", source: "agent", status: "idea" }))).toBeNull();
  });
  it("returns null for a human item no longer in idea", () => {
    expect(assignableId(item({ id: "d1", source: "human", status: "done" }))).toBeNull();
    expect(assignableId(item({ id: "x1", source: "human", status: "doing" }))).toBeNull();
  });
});

describe("emptyState", () => {
  it("mine tab nudges to the input; agent tab points at Giao cho PM", () => {
    const mine = emptyState("mine");
    expect(mine).toContain("No ideas yet");
    expect(mine).toContain("below and press Enter");

    const agent = emptyState("agent");
    expect(agent).toContain("No agent work yet");
    expect(agent).toContain("hand it to the PM");
  });
});
