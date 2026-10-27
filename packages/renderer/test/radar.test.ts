import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n";
import { RadarStore, radarItemHtml, radarText } from "../src/ui/radar";

const alertFrame = (over: Record<string, unknown> = {}, metaOver: Record<string, unknown> = {}) => ({
  type: "collision_alert",
  sessionId: "sess-b",
  agentId: "sess-b",
  ts: Date.now(),
  meta: {
    alertId: "al-1",
    kind: "file",
    severity: "hard",
    path: "/w/demo-app/src/x.ts",
    relPath: "src/x.ts",
    since: Date.now(),
    agents: [
      { agentId: "sess-a", sessionId: "sess-a", name: "alpha", harness: "claude-code", repo: "demo-app" },
      { agentId: "sess-b", sessionId: "sess-b", name: "beta", harness: "codex", repo: "demo-app" },
    ],
    ...metaOver,
  },
  ...over,
});

describe("RadarStore", () => {
  beforeEach(() => {
    setLang("en");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("collision_alert adds, collision_resolved removes", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame());
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ alertId: "al-1", kind: "file", severity: "hard" });
    store.onRaw({ type: "collision_resolved", meta: { alertId: "al-1" } });
    expect(store.list()).toEqual([]);
  });

  it("ignores unrelated and malformed frames", () => {
    const store = new RadarStore();
    store.onRaw({ type: "tool_call" });
    store.onRaw({ type: "collision_alert", meta: {} });
    store.onRaw({ type: "collision_alert", meta: { alertId: "x", agents: [] } });
    store.onRaw(null);
    expect(store.list()).toEqual([]);
  });

  it("the same alert replayed from the WS backlog is not duplicated", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame());
    store.onRaw(alertFrame());
    expect(store.list()).toHaveLength(1);
  });

  it("drops a frame that was replayed hours after it was sent", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame({ ts: Date.now() - 3 * 3600_000 }));
    expect(store.list()).toEqual([]);
  });

  it("keeps a live alert that has been open for hours (an update frame is fresh)", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame({}, { since: Date.now() - 3 * 3600_000 }));
    expect(store.list()).toHaveLength(1);
  });

  it("hard alerts sort above soft ones, newest first within a tier", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame({}, { alertId: "soft", severity: "soft", kind: "worktree", since: Date.now() }));
    store.onRaw(alertFrame({}, { alertId: "old-hard", since: Date.now() - 5000 }));
    store.onRaw(alertFrame({}, { alertId: "new-hard", since: Date.now() }));
    expect(store.list().map((a) => a.alertId)).toEqual(["new-hard", "old-hard", "soft"]);
  });

  it("backfill loads open alerts from GET /radar; a dead daemon is not an error", async () => {
    const store = new RadarStore();
    vi.mocked(fetch).mockResolvedValueOnce({ json: async () => ({ alerts: [alertFrame().meta] }) } as Response);
    await store.backfill();
    expect(store.list()).toHaveLength(1);

    // authoritative: an alert the daemon no longer lists is a ghost and goes; an old open one stays
    vi.mocked(fetch).mockResolvedValueOnce({
      json: async () => ({ alerts: [{ ...alertFrame().meta, alertId: "al-2", since: Date.now() - 5 * 3600_000 }] }),
    } as Response);
    await store.backfill();
    expect(store.list().map((a) => a.alertId)).toEqual(["al-2"]);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
    await expect(store.backfill()).resolves.toBeUndefined();
  });
});

describe("radarText / radarItemHtml", () => {
  beforeEach(() => setLang("en"));

  it("describes each kind with the agents' names and the file", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame());
    const a = store.list()[0];
    expect(radarText(a)).toEqual({ who: "Same file", what: "alpha and beta are editing x.ts" });
    expect(radarText({ ...a, kind: "worktree", severity: "soft" }).what).toBe("alpha and beta edit src/x.ts in different worktrees");
    expect(radarText({ ...a, kind: "worker" }).what).toBe("alpha and beta are workers on demo-app");
  });

  it("uses the names the office shows when it knows them", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame());
    const names: Record<string, string> = { "sess-a": "coder-01", "sess-b": "coder-02" };
    expect(radarText(store.list()[0], (id) => names[id]).what).toBe("coder-01 and coder-02 are editing x.ts");
    expect(radarText(store.list()[0], (id) => (id === "sess-a" ? "coder-01" : undefined)).what).toBe("coder-01 and beta are editing x.ts");
  });

  it("two agents that carry the same office name are told apart by repo", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame({}, { kind: "worktree", severity: "soft", relPath: "src/x.ts", agents: [
      { agentId: "a", sessionId: "a", name: "x", repo: "acme-web" },
      { agentId: "b", sessionId: "b", name: "y", repo: "acme-web-wt" },
    ] }));
    expect(radarText(store.list()[0], () => "coder-01").what).toBe(
      "coder-01 (acme-web) and coder-01 (acme-web-wt) edit src/x.ts in different worktrees",
    );
  });

  it("a third agent reads as a list", () => {
    const store = new RadarStore();
    store.onRaw(alertFrame({}, { agents: [
      { agentId: "a", sessionId: "a", name: "alpha" },
      { agentId: "c", sessionId: "c", name: "gamma" },
      { agentId: "b", sessionId: "b", name: "beta" },
    ] }));
    expect(radarText(store.list()[0]).what).toBe("alpha, gamma and beta are editing x.ts");
  });

  it("is Vietnamese when the UI language is", () => {
    setLang("vi");
    const store = new RadarStore();
    store.onRaw(alertFrame());
    expect(radarText(store.list()[0]).what).toBe("alpha và beta cùng sửa x.ts");
    setLang("en");
  });

  it("the row targets the agent that triggered it and escapes agent-controlled text", () => {
    const store = new RadarStore();
    store.onRaw(
      alertFrame({}, {
        agents: [
          { agentId: "a", sessionId: "a", name: "<img src=x onerror=alert(1)>", repo: "r" },
          { agentId: "b\"><script>", sessionId: "b", name: "beta", repo: "r" },
        ],
      }),
    );
    const html = radarItemHtml(store.list()[0]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain('class="radar radar-hard"');
    expect(html).toContain("data-agent-id=");
  });
});
