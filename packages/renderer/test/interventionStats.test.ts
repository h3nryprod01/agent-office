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
    expect(html).toContain("Nothing needed you yet");
    expect(html).not.toContain("median");
  });

  it("speaks Vietnamese when asked", () => {
    setLang("vi");
    expect(interventionStatsHtml(summary())).toContain("trung vị");
    setLang("en");
  });
});
