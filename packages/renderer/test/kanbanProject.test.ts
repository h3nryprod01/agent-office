// @vitest-environment happy-dom
// coordinator: the Board follows the office tab's project; a slow answer for the old project must not win
import { describe, expect, it } from "vitest";
import { mountKanban, type KanbanItem } from "../src/ui/kanban";

describe("kanban setProject", () => {
  it("ignores a late answer for the project it already left", async () => {
    const pending: Record<string, (v: { items: KanbanItem[] }) => void> = {};
    const fetchItems = (project: string) => new Promise<{ items: KanbanItem[] }>((res) => (pending[project] = res));
    const root = document.createElement("div");
    const k = mountKanban(root, { project: "a", fetchItems });
    void k.refresh(); // in flight for "a"
    k.setProject("b");
    pending.b({ items: [{ id: "b1", title: "card-of-b", source: "human", status: "idea" }] });
    await new Promise((r) => setTimeout(r, 0));
    pending.a({ items: [{ id: "a1", title: "card-of-a", source: "human", status: "idea" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(root.textContent).toContain("card-of-b");
    expect(root.textContent).not.toContain("card-of-a");
  });
});
