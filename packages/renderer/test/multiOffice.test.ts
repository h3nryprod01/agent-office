import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "../../protocol/src/events";
import { INITIAL_STATE, type OfficeState, repoFromCwd } from "../src/sim/model";
import { reduce } from "../src/sim/reducer";
import { TAB_LINGER_MS, filterStateByRepo, repoTabs } from "../src/sim/selectors";

let seq = 0;
function apply(state: OfficeState, partial: Partial<OfficeEvent> & { type: OfficeEvent["type"] }): OfficeState {
  seq += 1;
  return reduce(state, {
    v: 0,
    id: `e-${seq}`,
    timestamp: 1_000,
    sessionId: "sess",
    agentId: "a1",
    parentId: null,
    ...partial,
  } as OfficeEvent);
}

const spawn = (
  state: OfficeState,
  agentId: string,
  extra: Record<string, unknown> = {},
): OfficeState => apply(state, { type: "agent_spawned", agentId, name: agentId, role: null, ...extra });

describe("repoFromCwd (renderer fallback)", () => {
  it("uses the project-root basename", () => {
    expect(repoFromCwd("/Users/x/Projects/demo-app")).toBe("demo-app");
  });

  it("resolves .claude/worktrees/<x> to the root repo", () => {
    expect(repoFromCwd("/Users/x/Projects/Acme Web/.claude/worktrees/multi-office")).toBe("Acme Web");
    expect(repoFromCwd("/Users/x/P/repo/.claude/worktrees/wt/packages/renderer")).toBe("repo");
  });

  it('returns "other" for missing cwd', () => {
    expect(repoFromCwd(null)).toBe("other");
    expect(repoFromCwd("")).toBe("other");
  });
});

describe("reduce — repo assignment", () => {
  it("prefers the explicit repo field over cwd", () => {
    const s = spawn(INITIAL_STATE, "a1", { repo: "from-daemon", cwd: "/x/from-cwd" });
    expect(s.agents.get("a1")!.repo).toBe("from-daemon");
  });

  it("derives from cwd when repo is absent", () => {
    const s = spawn(INITIAL_STATE, "a1", { cwd: "/x/Projects/my-repo" });
    expect(s.agents.get("a1")!.repo).toBe("my-repo");
  });

  it("sub-agent without cwd inherits the parent's repo", () => {
    let s = spawn(INITIAL_STATE, "root", { cwd: "/x/Projects/my-repo" });
    s = spawn(s, "child", { parentId: "root" });
    expect(s.agents.get("child")!.repo).toBe("my-repo");
  });

  it('falls back to "other" with no repo, cwd, or known parent', () => {
    const s = spawn(INITIAL_STATE, "a1");
    expect(s.agents.get("a1")!.repo).toBe("other");
  });
});

describe("repoTabs", () => {
  function twoRepos(): OfficeState {
    let s = spawn(INITIAL_STATE, "g1", { repo: "gang" });
    s = spawn(s, "g2", { repo: "gang" });
    s = spawn(s, "t1", { repo: "demo-app" });
    return s;
  }

  it("one tab per repo with live agents, alphabetical, with live counts", () => {
    const tabs = repoTabs(twoRepos(), 2_000);
    expect(tabs.map((t) => [t.repo, t.liveCount])).toEqual([
      ["demo-app", 1],
      ["gang", 2],
    ]);
  });

  it("flags hasAlert when a live agent is in an alert status", () => {
    let s = twoRepos();
    s = apply(s, { type: "agent_status_changed", agentId: "t1", status: "waiting_permission", detail: null });
    const tabs = repoTabs(s, 2_000);
    expect(tabs.find((t) => t.repo === "demo-app")!.hasAlert).toBe(true);
    expect(tabs.find((t) => t.repo === "gang")!.hasAlert).toBe(false);
  });

  it("keeps an emptied repo's tab during the linger window, then closes it", () => {
    let s = twoRepos();
    s = apply(s, { type: "agent_despawned", agentId: "t1", reason: null, timestamp: 10_000 });
    const during = repoTabs(s, 10_000 + TAB_LINGER_MS - 1);
    expect(during.map((t) => [t.repo, t.liveCount])).toContainEqual(["demo-app", 0]);
    const after = repoTabs(s, 10_000 + TAB_LINGER_MS + 1);
    expect(after.map((t) => t.repo)).toEqual(["gang"]);
  });
});

describe("filterStateByRepo", () => {
  it("keeps only the repo's agents; other state fields untouched", () => {
    let s = spawn(INITIAL_STATE, "g1", { repo: "gang" });
    s = spawn(s, "t1", { repo: "demo-app" });
    const filtered = filterStateByRepo(s, "gang");
    expect([...filtered.agents.keys()]).toEqual(["g1"]);
    expect(filtered.sessionId).toBe(s.sessionId);
    // original untouched (immutability)
    expect(s.agents.size).toBe(2);
  });
});
