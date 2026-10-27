import { beforeEach, describe, expect, it } from "vitest";
import { PolicyAlertsStore } from "../src/ui/policyAlerts";

const frame = (over: Record<string, unknown> = {}) => ({
  type: "policy_alert",
  id: "policy_alert:s1|harness|codex",
  ts: Date.now(),
  meta: { project: "acme-web", projectName: "Acme Web", kind: "harness", value: "codex", allowed: ["claude"], targetSessionId: "s1" },
  ...over,
});

describe("PolicyAlertsStore", () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
  });

  it("ignores everything that is not a well-formed policy_alert", () => {
    const store = new PolicyAlertsStore();
    store.onRaw(null);
    store.onRaw({ type: "tool_call" });
    store.onRaw({ type: "policy_alert", id: "x", meta: {} });
    store.onRaw(frame({ id: undefined }));
    expect(store.list()).toEqual([]);
  });

  it("collects alerts newest-first and de-duplicates a replayed frame", () => {
    const store = new PolicyAlertsStore();
    store.onRaw(frame({ ts: Date.now() - 5000 }));
    store.onRaw(frame({ id: "policy_alert:s2|lane|kimi", meta: { project: "acme-web", kind: "lane", value: "kimi", allowed: ["glm"], targetSessionId: "s2" } }));
    store.onRaw(frame({ ts: Date.now() - 5000 })); // WS reconnect replays the backlog
    expect(store.list().map((a) => a.value)).toEqual(["kimi", "codex"]);
    expect(store.list()[1]).toMatchObject({ project: "acme-web", projectName: "Acme Web", allowed: ["claude"], targetSessionId: "s1" });
  });

  it("drops day-old alerts replayed from the backlog", () => {
    const store = new PolicyAlertsStore();
    store.onRaw(frame({ ts: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(store.list()).toEqual([]);
  });

  it("dismiss removes it and keeps it removed when the frame comes back", () => {
    const store = new PolicyAlertsStore();
    store.onRaw(frame());
    store.dismiss("policy_alert:s1|harness|codex");
    expect(store.list()).toEqual([]);
    store.onRaw(frame());
    expect(store.list()).toEqual([]);
    // and a fresh page load remembers it too
    const reloaded = new PolicyAlertsStore();
    reloaded.onRaw(frame());
    expect(reloaded.list()).toEqual([]);
  });
});

import { ApprovalsStore } from "../src/ui/approvals";

describe("ApprovalsStore + policy", () => {
  it("keeps the policy reasons of a forced ask so the queue can say why it asked", () => {
    const store = new ApprovalsStore();
    store.onRaw({
      type: "approval_pending",
      sessionId: "s1",
      tool: "Bash",
      meta: {
        approvalId: "a-1",
        preview: "git push --force",
        expiresAt: Date.now() + 30_000,
        policy: { project: "acme-web", mode: "auto", forced: "danger", reasons: ["force-push"] },
      },
    });
    expect(store.list()[0].policy).toEqual({ project: "acme-web", mode: "auto", forced: "danger", reasons: ["force-push"] });
  });

  it("a policy-made resolution (an id that was never pending) is harmless", () => {
    const store = new ApprovalsStore();
    store.onRaw({ type: "approval_resolved", meta: { approvalId: "never-pending", source: "policy", decision: "allow" } });
    expect(store.list()).toEqual([]);
  });
});
