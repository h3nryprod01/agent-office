import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../src/i18n";
import { fmtDuration, interventionStatsHtml, type InterventionSummary } from "../src/ui/interventionStats";

const stat = (count: number, medianMs: number, p90Ms: number) => ({ count, medianMs, p90Ms, totalMs: 0 });
const summary = (over: Partial<InterventionSummary> = {}): InterventionSummary => ({
  window: { from: "2026-10-21", to: "2026-10-27", days: 7 },
  total: stat(12, 42_000, 185_000),
  byKind: { waiting_permission: stat(8, 61_000, 240_000), error: stat(4, 5_000, 9_000) },
  ...over,
});

describe("fmtDuration", () => {
  it("scales from seconds to hours", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(400)).toBe("<1s");
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(185_000)).toBe("3m 05s");
    expect(fmtDuration(3_600_000)).toBe("1h 00m");
    expect(fmtDuration(4_980_000)).toBe("1h 23m");
  });
});

describe("interventionStatsHtml", () => {
  beforeEach(() => setLang("en"));

  it("headline: median, p90, count; then one row per kind in a fixed order", () => {
    const html = interventionStatsHtml(summary());
    expect(html).toContain("42s");
    expect(html).toContain("3m 05s");
    expect(html).toContain("<b>12×</b>");
    expect(html.indexOf("Waiting for approval")).toBeGreaterThan(-1);
    expect(html.indexOf("Waiting for approval")).toBeLessThan(html.indexOf("Error"));
    expect(html).not.toContain("Blocked"); // zero-count kinds stay out
  });

  it("empty window says so instead of showing zeros", () => {
    const html = interventionStatsHtml(summary({ total: stat(0, 0, 0), byKind: {} }));
    expect(html).toContain("No waits in the last 7 days");
    expect(html).not.toContain("hook");
    expect(html).not.toContain("median");
  });

  it("says why only when nothing was ever recorded (errors need no hook; approval waits do)", () => {
    const html = interventionStatsHtml(summary({ total: stat(0, 0, 0), byKind: {}, anyRecords: false }));
    expect(html).toContain("notify.mjs");
    expect(html).toContain("transcripts");
    expect(html).not.toContain("ao approvals setup");
  });

  it("speaks Vietnamese when asked", () => {
    setLang("vi");
    expect(interventionStatsHtml(summary())).toContain("trung vị");
    setLang("en");
  });
});

const full = (over: Partial<InterventionSummary> = {}): InterventionSummary =>
  summary({
    window: { from: "2026-10-12", to: "2026-11-10", days: 30 },
    total: { count: 120, medianMs: 40_000, p90Ms: 720_000, totalMs: 4_800_000 },
    longest: { durationMs: 11_400_000, kind: "waiting_permission", project: "acme-web", harness: "claude-code", endTs: 0 },
    permission: { count: 120, denied: 5, denyRate: 5 / 120 },
    autoApproved: 9,
    byProject: { "acme-web": { count: 70, medianMs: 1, p90Ms: 1, totalMs: 3_000_000 }, "acme-api": { count: 50, medianMs: 1, p90Ms: 1, totalMs: 1_800_000 } },
    byHarness: [{ harness: "claude-code", count: 100, medianMs: 1, p90Ms: 1, totalMs: 4_000_000 }, { harness: "claude-worker", count: 20, medianMs: 1, p90Ms: 1, totalMs: 800_000 }],
    ...over,
  });

describe("interventionStatsHtml (report fields)", () => {
  beforeEach(() => setLang("en"));

  it("shows total wait, longest, decline rate, auto-approvals and the window length", () => {
    const html = interventionStatsHtml(full());
    expect(html).toContain("last 30 days");
    expect(html).toContain("1h 20m"); // total wait
    expect(html).toContain("3h 10m"); // longest
    expect(html).toContain("4%"); // 5 of 120
    expect(html).toContain("<b>9</b>"); // auto-approved
  });

  it("lists projects and harnesses, biggest total wait first", () => {
    const html = interventionStatsHtml(full());
    expect(html.indexOf("acme-web")).toBeGreaterThan(-1);
    expect(html.indexOf("acme-web")).toBeLessThan(html.indexOf("acme-api"));
    expect(html.indexOf("claude-code")).toBeLessThan(html.indexOf("claude-worker"));
  });

  it("an older daemon that sends only the basic fields still renders", () => {
    const html = interventionStatsHtml(summary());
    expect(html).toContain("42s");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("leaves the auto-approved line out when the daemon has no policy audit", () => {
    expect(interventionStatsHtml(full({ autoApproved: null }))).not.toContain("Auto-approved");
  });

  it("escapes a project name", () => {
    const html = interventionStatsHtml(full({ byProject: { "<img src=x onerror=1>": { count: 1, medianMs: 1, p90Ms: 1, totalMs: 1 } } }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("has the 7/30 switch and the save-image button", () => {
    const html = interventionStatsHtml(full());
    expect(html).toContain('data-days="7"');
    expect(html).toContain('data-days="30"');
    expect(html).toContain("iv-share");
  });
});
