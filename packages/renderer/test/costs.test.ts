import { describe, expect, it } from "vitest";
import {
  agentLabel,
  costTableHtml,
  costsPanelHtml,
  fmtTokens,
  fmtUsd,
  type CostsPayload,
} from "../src/ui/costs";
import type { WorkItem } from "../src/ui/workItems";

const row = { usd: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

const PAYLOAD: CostsPayload = {
  window: "24h",
  totalUsd: 1.2345,
  tokensTotal: 2_500_000,
  tokens: { input: 1_000_000, output: 500_000, cacheWrite: 400_000, cacheRead: 600_000 },
  byRepo: [
    { ...row, repo: "agent-office", usd: 1.0, tokens: 2_000_000 },
    { ...row, repo: "demo-app", usd: 0.2345, tokens: 500_000 },
  ],
  byAgent: [
    { ...row, sessionId: "abcdef12-3456", repo: "agent-office", harness: "claude-code", usd: 1.0, tokens: 2_000_000 },
  ],
  byDay: [{ ...row, day: "2026-07-08", usd: 1.2345, tokens: 2_500_000 }],
  byHarness: [
    { ...row, harness: "claude-code", usd: 1.2345, tokens: 2_000_000 },
    { ...row, harness: "codex", usd: 0, tokens: 400_000 },
    { ...row, harness: "gemini", usd: 0, tokens: 100_000 },
  ],
  unknownModels: [{ model: "claude-fable-5", tokens: 123_000 }],
};

describe("formatters", () => {
  it("fmtUsd: 2 decimals above $1, 3 below", () => {
    expect(fmtUsd(12.345)).toBe("$12.35");
    expect(fmtUsd(0.0042)).toBe("$0.004");
  });
  it("fmtTokens: M/k/plain", () => {
    expect(fmtTokens(2_500_000)).toBe("2.5M");
    expect(fmtTokens(34_200)).toBe("34k");
    expect(fmtTokens(512)).toBe("512");
  });
});

describe("costTableHtml", () => {
  it("bars scale on usd; biggest row gets 100%", () => {
    const html = costTableHtml("Theo repo", [
      { usd: 2, tokens: 10, label: "a" },
      { usd: 1, tokens: 99, label: "b" },
    ]);
    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
  });
  it("falls back to token-scaled bars when nothing is priced", () => {
    const html = costTableHtml("t", [
      { usd: 0, tokens: 100, label: "a" },
      { usd: 0, tokens: 50, label: "b" },
    ]);
    expect(html).toContain("width:100%");
    expect(html).toContain("width:50%");
  });
  it("escapes labels", () => {
    expect(costTableHtml("t", [{ usd: 1, tokens: 1, label: "<img>" }])).not.toContain("<img>");
  });
  it("empty rows → no section", () => {
    expect(costTableHtml("t", [])).toBe("");
  });
});

describe("agentLabel", () => {
  const items: WorkItem[] = [
    { id: "wi-x", title: "Cost dashboard", assignee: "cost-engineer", sessionId: "abcdef12-3456" },
  ];
  it("uses registry assignee when the session is known", () => {
    expect(agentLabel("abcdef12-3456", items)).toBe("cost-engineer");
  });
  it("falls back to short session id", () => {
    expect(agentLabel("99999999-8888", items)).toBe("99999999");
  });
});

describe("costsPanelHtml over budget", () => {
  it("shows the over-budget warning when over, hides it when under", () => {
    const over = costsPanelHtml({ ...PAYLOAD, budgetUsd: 1, overBudget: true }, []);
    expect(over).toContain("Vượt ngân sách");
    const under = costsPanelHtml({ ...PAYLOAD, budgetUsd: 999, overBudget: false }, []);
    expect(under).not.toContain("Vượt ngân sách");
  });
});

describe("costsPanelHtml", () => {
  const html = costsPanelHtml(PAYLOAD, []);
  it("shows total, window buttons, and all four tables", () => {
    expect(html).toContain("$1.23");
    expect(html).toContain("2.5M tokens");
    expect(html).toContain('data-window="7d"');
    expect(html).toContain("Theo harness");
    expect(html).toContain("Theo repo");
    expect(html).toContain("Theo agent");
    expect(html).toContain("Theo ngày");
    expect(html).toContain("agent-office");
  });
  it("lists every harness, including the ones whose models have no price", () => {
    expect(html).toContain("claude-code");
    expect(html).toContain("codex");
    expect(html).toContain("gemini");
  });
  it("a pre-multiharness daemon (no byHarness) renders without the section, not a crash", () => {
    const stale = { ...PAYLOAD, byHarness: undefined };
    const out = costsPanelHtml(stale, []);
    expect(out).not.toContain("Theo harness");
    expect(out).toContain("Theo repo");
  });
  it("marks the active window", () => {
    expect(html).toMatch(/cost-window active" data-window="24h"/);
  });
  it("lists unpriced models", () => {
    expect(html).toContain("claude-fable-5");
    expect(html).toContain("123k");
  });
});
