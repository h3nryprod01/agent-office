import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalsStore } from "../src/ui/approvals";

const pendingFrame = (over: Record<string, unknown> = {}) => ({
  type: "approval_pending",
  sessionId: "sess-1",
  tool: "Bash",
  meta: { approvalId: "a-1", preview: "rm -rf x", expiresAt: Date.now() + 30_000 },
  ...over,
});

describe("ApprovalsStore", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores frames without an approvalId", () => {
    const store = new ApprovalsStore();
    store.onRaw({ type: "approval_pending", meta: {} });
    store.onRaw({ type: "tool_call" });
    store.onRaw(null);
    expect(store.list()).toEqual([]);
  });

  it("approval_pending adds, approval_resolved removes", () => {
    const store = new ApprovalsStore();
    store.onRaw(pendingFrame());
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ id: "a-1", tool: "Bash", preview: "rm -rf x" });

    store.onRaw({ type: "approval_resolved", meta: { approvalId: "a-1" } });
    expect(store.list()).toEqual([]);
  });

  it("drops an already-expired pending frame (stale WS backlog replay)", () => {
    const store = new ApprovalsStore();
    store.onRaw(pendingFrame({ meta: { approvalId: "a-1", expiresAt: Date.now() - 1000 } }));
    expect(store.list()).toEqual([]);
  });

  it("list() prunes items whose expiresAt has passed", () => {
    const store = new ApprovalsStore();
    store.onRaw(pendingFrame({ meta: { approvalId: "a-1", expiresAt: Date.now() + 10 } }));
    expect(store.list(Date.now())).toHaveLength(1);
    expect(store.list(Date.now() + 20)).toEqual([]);
  });

  it("list() sorts by soonest-to-expire first", () => {
    const store = new ApprovalsStore();
    const now = Date.now();
    store.onRaw(pendingFrame({ meta: { approvalId: "late", expiresAt: now + 20_000 } }));
    store.onRaw(pendingFrame({ meta: { approvalId: "soon", expiresAt: now + 5_000 } }));
    expect(store.list(now).map((p) => p.id)).toEqual(["soon", "late"]);
  });

  it("respond() removes the item immediately (optimistic) and POSTs the decision", async () => {
    const store = new ApprovalsStore();
    store.onRaw(pendingFrame());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await store.respond("a-1", "allow");
    expect(store.list()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/approval-response",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "a-1", decision: "allow" }),
      }),
    );
  });

  it("respond() never throws when the daemon is unreachable", async () => {
    const store = new ApprovalsStore();
    store.onRaw(pendingFrame());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(store.respond("a-1", "deny")).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it("backfill() populates from GET /approvals and skips already-expired entries", async () => {
    const store = new ApprovalsStore();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      json: async () => ({
        items: [
          { id: "fresh", sessionId: "s1", tool: "Bash", preview: "x", expiresAt: Date.now() + 10_000 },
          { id: "stale", sessionId: "s1", tool: "Bash", preview: "y", expiresAt: Date.now() - 10_000 },
        ],
      }),
    });

    await store.backfill();
    expect(store.list().map((p) => p.id)).toEqual(["fresh"]);
  });

  it("backfill() never throws when the daemon is unreachable", async () => {
    const store = new ApprovalsStore();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(store.backfill()).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});
