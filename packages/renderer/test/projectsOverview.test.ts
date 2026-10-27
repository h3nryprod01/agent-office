import { describe, expect, it } from "vitest";
import {
  attentionRank,
  initials,
  pmBadge,
  renderProjectCard,
  sortProjects,
  type OverviewProject,
} from "../src/ui/projectsOverview";

const project = (over: Partial<OverviewProject> & Pick<OverviewProject, "slug">): OverviewProject => ({
  name: over.slug,
  template: "coding",
  pm: { state: "idle", queued: 0, unread: 0, lastAt: null, lastText: "", lastError: null },
  items: { idea: 0, doing: 0, review: 0, done: 0, dropped: 0 },
  pendingApprovals: 0,
  members: [],
  rooms: [],
  ...over,
});

describe("pmBadge", () => {
  it("idle PM", () => {
    expect(pmBadge({ state: "idle", queued: 0, unread: 0, lastAt: null, lastText: "", lastError: null }).kind).toBe("idle");
  });
  it("a PM that never ran (no pm row) is idle too", () => {
    expect(pmBadge(null).kind).toBe("idle");
  });
  it("working shows the queue behind it", () => {
    const b = pmBadge({ state: "working", queued: 2, unread: 0, lastAt: null, lastText: "", lastError: null });
    expect(b.kind).toBe("working");
    expect(b.label).toContain("2");
  });
  it("an idle PM whose last turn failed is flagged", () => {
    expect(pmBadge({ state: "idle", queued: 0, unread: 0, lastAt: 1, lastText: "x", lastError: "boom" }).kind).toBe("error");
  });
});

describe("sortProjects", () => {
  it("puts what needs a human first: approvals, then working PMs, then unread, then by name", () => {
    const list = [
      project({ slug: "calm" }),
      project({ slug: "unread", pm: { state: "idle", queued: 0, unread: 2, lastAt: 1, lastText: "", lastError: null } }),
      project({ slug: "busy", pm: { state: "working", queued: 0, unread: 0, lastAt: null, lastText: "", lastError: null } }),
      project({ slug: "stuck", pendingApprovals: 1 }),
      project({ slug: "alpha" }),
    ];
    expect(sortProjects(list).map((p) => p.slug)).toEqual(["stuck", "busy", "unread", "alpha", "calm"]);
  });
  it("does not mutate its input", () => {
    const list = [project({ slug: "b" }), project({ slug: "a" })];
    sortProjects(list);
    expect(list.map((p) => p.slug)).toEqual(["b", "a"]);
  });
  it("attentionRank orders by urgency", () => {
    expect(attentionRank(project({ slug: "a", pendingApprovals: 1 }))).toBeLessThan(attentionRank(project({ slug: "b" })));
  });
});

describe("initials", () => {
  it("first letters of the first two words, upper-case", () => {
    expect(initials("Nguyen Lan")).toBe("NL");
    expect(initials("binh")).toBe("B");
    expect(initials("  ")).toBe("?");
  });
});

describe("renderProjectCard", () => {
  const rich = project({
    slug: "demo-app",
    name: "Demo <App>",
    pm: { state: "working", queued: 1, unread: 3, lastAt: 1, lastText: "", lastError: null },
    items: { idea: 1, doing: 2, review: 0, done: 5, dropped: 0 },
    pendingApprovals: 2,
    members: [
      { id: "m-1", name: "Lan", role: "owner", channels: ["telegram"] },
      { id: "m-2", name: "Cam", role: "viewer", channels: [] },
    ],
    rooms: ["telegram"],
  });

  it("escapes names — a project called <script> must not become markup", () => {
    const html = renderProjectCard(rich, { canManage: true, formOpen: false, code: null, telegramOn: true });
    expect(html).not.toContain("<App>");
    expect(html).toContain("Demo &#60;App&#62;");
  });

  it("shows PM state, unread, approvals, item counts and members with their roles", () => {
    const html = renderProjectCard(rich, { canManage: true, formOpen: false, code: null, telegramOn: true });
    expect(html).toContain("data-open-pm=\"demo-app\"");
    expect(html).toContain("pm-working");
    expect(html).toContain("3"); // unread
    expect(html).toContain("Doing 2");
    expect(html).toContain("role-owner");
    expect(html).toContain("role-viewer");
    expect(html).toMatch(/2 waiting for approval|2 việc chờ duyệt/);
  });

  it("owner controls (add member, remove) only when the viewer of the page may manage", () => {
    const withControls = renderProjectCard(rich, { canManage: true, formOpen: false, code: null, telegramOn: true });
    expect(withControls).toContain("data-add-member=\"demo-app\"");
    expect(withControls).toContain("data-remove-member");
    const without = renderProjectCard(rich, { canManage: false, formOpen: false, code: null, telegramOn: true });
    expect(without).not.toContain("data-add-member");
    expect(without).not.toContain("data-remove-member");
  });

  it("an open form offers the three roles; a minted code is shown with the command to send", () => {
    const html = renderProjectCard(rich, {
      canManage: true,
      formOpen: true,
      code: { code: "AO-ABCD2345", expiresAt: Date.UTC(2026, 0, 1, 12, 0), role: "manager" },
      telegramOn: true,
    });
    expect(html).toContain("data-make-code=\"demo-app\"");
    expect(html).toContain("value=\"manager\"");
    expect(html).toContain("value=\"viewer\"");
    expect(html).toContain("value=\"owner\"");
    expect(html).toContain("AO-ABCD2345");
    expect(html).toContain("/pair AO-ABCD2345");
  });

  it("tells how to get a room when none is bound, and when Telegram itself is off", () => {
    const noRoom = renderProjectCard(project({ slug: "acme-web" }), { canManage: true, formOpen: false, code: null, telegramOn: true });
    expect(noRoom).toContain("/bind acme-web");
    const off = renderProjectCard(project({ slug: "acme-web" }), { canManage: true, formOpen: false, code: null, telegramOn: false });
    expect(off).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("an empty member list says so", () => {
    const html = renderProjectCard(project({ slug: "x" }), { canManage: true, formOpen: false, code: null, telegramOn: true });
    expect(html).toMatch(/No members yet|Chưa có thành viên/);
  });
});
