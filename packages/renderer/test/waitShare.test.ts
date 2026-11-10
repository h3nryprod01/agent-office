import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../src/i18n";
import { createMasker } from "../src/presentation/mask";
import { interventionStatsHtml, type InterventionSummary } from "../src/ui/interventionStats";
import { buildShareModel, drawShareCard, shareFileName } from "../src/ui/waitShare";

const S = (count: number, totalMs: number) => ({ count, medianMs: 1000, p90Ms: 2000, totalMs });
const REAL = ["hanoi-clinic-crm", "tran-van-an-portal"];
const summary = (): InterventionSummary => ({
  window: { from: "2026-11-04", to: "2026-11-10", days: 7 },
  total: S(40, 3_600_000),
  longest: { durationMs: 900_000, kind: "waiting_permission", project: REAL[0], harness: "claude-code", endTs: 0 },
  permission: { count: 30, denied: 3, denyRate: 0.1 },
  autoApproved: 5,
  byKind: { waiting_permission: S(30, 3_000_000), error: S(10, 600_000) },
  byProject: { [REAL[0]]: S(25, 2_500_000), [REAL[1]]: S(15, 1_100_000) },
  byHarness: [{ harness: "claude-code", ...S(40, 3_600_000) }],
});

/** A recording 2D context: every string that would be painted. */
function fakeCtx() {
  const texts: string[] = [];
  const noop = () => undefined;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k === "fillText" ? (s: string) => texts.push(s) : k in t ? t[k] : noop),
    set: (t, k: string, v) => ((t[k] = v), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts };
}

describe("buildShareModel", () => {
  beforeEach(() => setLang("en"));

  it("carries the headline numbers", () => {
    const m = buildShareModel(summary(), { showProjects: true });
    const flat = JSON.stringify(m);
    expect(flat).toContain("1h 00m"); // total wait
    expect(flat).toContain("15m 00s"); // longest
    expect(flat).toContain("40");
  });

  it("leaves project names out of the image unless told they are safe", () => {
    const flat = JSON.stringify(buildShareModel(summary(), { showProjects: false }));
    for (const name of REAL) expect(flat).not.toContain(name);
  });

  it("empty window still gives a model (no NaN)", () => {
    const empty = { ...summary(), total: S(0, 0), longest: null, byProject: {}, byHarness: [], byKind: {} };
    const flat = JSON.stringify(buildShareModel(empty, { showProjects: true }));
    expect(flat).not.toContain("NaN");
    expect(flat).not.toContain("undefined");
  });
});

describe("presentation mode: no real project name reaches the card or the image", () => {
  beforeEach(() => setLang("en"));

  it("card DOM, image model and every painted string use aliases", () => {
    const masked = createMasker().mask(summary());
    const html = interventionStatsHtml(masked);
    const model = JSON.stringify(buildShareModel(masked, { showProjects: true }));
    const { ctx, texts } = fakeCtx();
    drawShareCard(ctx, buildShareModel(masked, { showProjects: true }), 1200, 630);
    for (const name of REAL) {
      expect(html).not.toContain(name);
      expect(model).not.toContain(name);
      expect(texts.join("\n")).not.toContain(name);
    }
    expect(html).toContain("project-1");
    expect(texts.join("\n")).toContain("project-1");
  });

  it("control: unmasked data does show the names (the scan can fail)", () => {
    expect(interventionStatsHtml(summary())).toContain(REAL[0]);
  });
});

describe("shareFileName", () => {
  it("is dated and has no project name", () => {
    expect(shareFileName(summary())).toBe("agent-wait-2026-11-04_2026-11-10.png");
  });
});
