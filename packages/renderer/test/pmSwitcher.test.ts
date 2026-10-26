import { describe, expect, it } from "vitest";
import { applyPmStatus, chatKeyFor, renderPmChips, type PmRow } from "../src/ui/pmSwitcher";

const row = (slug: string, over: Partial<PmRow> = {}): PmRow => ({
  slug,
  name: slug,
  state: "idle",
  queued: 0,
  unread: 0,
  lastError: null,
  ...over,
});

describe("chatKeyFor", () => {
  it("namespaces project PMs so a project called like a repo cannot share its transcript", () => {
    expect(chatKeyFor("demo-app")).toBe("pm:demo-app");
  });
});

describe("applyPmStatus", () => {
  it("updates one PM's state, queue and unread from a pm_status frame, leaving the others alone", () => {
    const pms = [row("a"), row("b")];
    const next = applyPmStatus(pms, { type: "pm_status", meta: { project: "b", state: "working", queued: 2, unread: 1 } });
    expect(next.find((p) => p.slug === "b")).toMatchObject({ state: "working", queued: 2, unread: 1 });
    expect(next.find((p) => p.slug === "a")).toEqual(row("a"));
    expect(pms[1]).toEqual(row("b")); // input untouched
  });

  it("a status for a project we have not listed yet adds it (new project, list not refetched)", () => {
    const next = applyPmStatus([row("a")], { type: "pm_status", meta: { project: "new", state: "idle", queued: 0, unread: 0 } });
    expect(next.map((p) => p.slug)).toEqual(["a", "new"]);
  });

  it("ignores frames that are not pm_status or are malformed", () => {
    const pms = [row("a")];
    expect(applyPmStatus(pms, { type: "chat_message" })).toBe(pms);
    expect(applyPmStatus(pms, { type: "pm_status", meta: {} })).toBe(pms);
    expect(applyPmStatus(pms, null)).toBe(pms);
  });
});

describe("renderPmChips", () => {
  it("is empty when there are no projects, so the chat box looks exactly as before", () => {
    expect(renderPmChips([], null, "Repo PM")).toBe("");
  });

  it("one chip for the repo PM, one per project; the active one is marked", () => {
    const html = renderPmChips([row("a"), row("b", { unread: 3 })], "a", "Repo PM");
    expect(html).toContain('data-pm=""');
    expect(html).toContain('data-pm="a"');
    expect(html).toContain('data-pm="b"');
    expect(html.match(/class="pm-chip[^"]*active/g)?.length).toBe(1);
    expect(html).toMatch(/data-pm="b"[^>]*>[^]*?pm-unread[^]*?3/);
  });

  it("shows a working PM and escapes names", () => {
    const html = renderPmChips([row("x", { name: "<b>x</b>", state: "working", queued: 1 })], null, "Repo PM");
    expect(html).toContain("pm-working");
    expect(html).not.toContain("<b>x</b>");
  });
});
