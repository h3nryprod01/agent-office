import { describe, expect, it } from "vitest";
import {
  ancestryOf,
  whyChainHtml,
  matchWorkItem,
  workItemLinksHtml,
  workItemSectionHtml,
  OBSIDIAN_VAULT,
  type WorkItem,
} from "../src/ui/workItems";

const agent = (over: Partial<Parameters<typeof matchWorkItem>[0]> = {}) => ({
  sessionId: "sess-1",
  name: "deeplink-engineer",
  role: null,
  cwd: null,
  ...over,
});

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "wi-a",
  title: "A",
  status: "in_progress",
  ...over,
});

describe("matchWorkItem", () => {
  it("prefers exact sessionId over assignee heuristic", () => {
    const items = [
      item({ id: "wi-assignee", assignee: "deeplink-engineer" }),
      item({ id: "wi-session", sessionId: "sess-1", assignee: "someone-else" }),
    ];
    expect(matchWorkItem(agent(), items)?.id).toBe("wi-session");
  });

  it("matches assignee against agent name/role, either direction", () => {
    const items = [item({ id: "wi-a", assignee: "deeplink" })];
    expect(matchWorkItem(agent({ name: "Deeplink-Engineer" }), items)?.id).toBe("wi-a");
    // assignee contains the agent name
    expect(
      matchWorkItem(agent({ name: "deeplink" }), [item({ id: "wi-b", assignee: "deeplink-engineer" })])?.id,
    ).toBe("wi-b");
  });

  it("falls back to branch-segment-in-cwd, and null when nothing matches", () => {
    const items = [item({ id: "wi-br", branch: "feat/work-item-links", assignee: "other" })];
    expect(
      matchWorkItem(agent({ name: "x", cwd: "/repo/.claude/worktrees/work-item-links" }), items)?.id,
    ).toBe("wi-br");
    expect(matchWorkItem(agent({ name: "x", cwd: "/elsewhere" }), items)).toBeNull();
    expect(matchWorkItem(agent({ name: "x" }), items)).toBeNull();
  });
});

describe("workItemLinksHtml", () => {
  it("renders Plane dimmed when offline, hides Obsidian/PR when null", () => {
    const html = workItemLinksHtml(item({ planeUrl: null, pr: null, obsidianNote: null }));
    expect(html).toContain("Plane offline");
    expect(html).not.toContain("obsidian://");
    expect(html).not.toContain(">PR<");
  });

  it("renders live links with the real vault name", () => {
    const html = workItemLinksHtml(
      item({
        planeUrl: "http://localhost:8080/mission-control/x",
        pr: "https://github.com/h3nryprod01/agent-office/pull/8",
        obsidianNote: "AI-Memory/Projects/note.md",
      }),
    );
    expect(html).toContain('href="http://localhost:8080/mission-control/x"');
    expect(html).toContain("/pull/8");
    expect(html).toContain(`vault=${encodeURIComponent(OBSIDIAN_VAULT)}`);
    expect(html).toContain(encodeURIComponent("AI-Memory/Projects/note.md"));
  });

  it("escapes html in registry values", () => {
    const html = workItemSectionHtml(agent({ sessionId: "s" }), [
      item({ sessionId: "s", title: '<img src=x onerror="1">' }),
    ]);
    expect(html).not.toContain("<img");
  });
});

describe("workItemSectionHtml states", () => {
  it("mock mode / loading / no match placeholders", () => {
    expect(workItemSectionHtml(agent(), undefined)).toContain("live mode");
    expect(workItemSectionHtml(agent(), null)).toContain("Loading");
    expect(workItemSectionHtml(agent({ name: "x" }), [])).toContain("No work item");
  });
});

describe("ancestryOf", () => {
  it("đi từ item lên tới root theo parentItemId", () => {
    const items = [
      item({ id: "a", parentItemId: "b" }),
      item({ id: "b", parentItemId: "c" }),
      item({ id: "c" }),
    ];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("item không cha → chuỗi 1 phần tử", () => {
    const items = [item({ id: "a" })];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a"]);
  });

  it("orphan: parentItemId trỏ item đã xóa → dừng, không ném", () => {
    const items = [item({ id: "a", parentItemId: "ghost" })];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a"]);
  });

  it("cycle A→B→A → không treo, trả đúng phần đã đi", () => {
    const items = [item({ id: "a", parentItemId: "b" }), item({ id: "b", parentItemId: "a" })];
    expect(ancestryOf(items[0], items).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("whyChainHtml", () => {
  it("chuỗi nhiều tầng → chứa mọi tiêu đề + nhãn Why", () => {
    const items = [
      item({ id: "a", title: "việc a", parentItemId: "b" }),
      item({ id: "b", title: "việc b", parentItemId: "c" }),
      item({ id: "c", title: "việc c" }),
    ];
    const html = whyChainHtml(items[0], items);
    expect(html).toContain("Why");
    expect(html).toContain("việc a");
    expect(html).toContain("việc b");
    expect(html).toContain("việc c");
  });

  it("item không cha → chuỗi rỗng (không có gì để giải thích)", () => {
    const items = [item({ id: "a" })];
    expect(whyChainHtml(items[0], items)).toBe("");
  });

  it("escape tiêu đề (chống XSS)", () => {
    const items = [item({ id: "a", parentItemId: "b" }), item({ id: "b", title: "<img src=x>" })];
    expect(whyChainHtml(items[0], items)).not.toContain("<img src=x>");
  });
});
