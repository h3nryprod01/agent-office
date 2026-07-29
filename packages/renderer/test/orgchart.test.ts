import { describe, expect, it } from "vitest";
import type { OfficeEvent } from "../../protocol/src/events";
import { INITIAL_STATE, type OfficeState } from "../src/sim/model";
import { reduce } from "../src/sim/reducer";
import { orgForest, type OrgNode } from "../src/sim/selectors";

let seq = 0;
function apply(
  state: OfficeState,
  partial: Partial<OfficeEvent> & { type: OfficeEvent["type"] },
): OfficeState {
  seq += 1;
  return reduce(state, {
    v: 0,
    id: `e-${seq}`,
    timestamp: 1_000 + seq,
    sessionId: "sess",
    agentId: "a1",
    parentId: null,
    ...partial,
  } as OfficeEvent);
}

function spawn(
  state: OfficeState,
  agentId: string,
  opts: { parentId?: string; repo?: string } = {},
): OfficeState {
  return apply(state, {
    type: "agent_spawned",
    agentId,
    name: agentId,
    role: null,
    parentId: opts.parentId ?? null,
    repo: opts.repo ?? "repo-a",
  } as Partial<OfficeEvent> & { type: "agent_spawned" });
}

const setStatus = (state: OfficeState, agentId: string, status: string): OfficeState =>
  apply(state, { type: "agent_status_changed", agentId, status, detail: null } as Partial<OfficeEvent> & {
    type: "agent_status_changed";
  });

const ids = (nodes: OrgNode[]): string[] => nodes.map((n) => n.agent.agentId);

describe("orgForest", () => {
  it("nests sub-agents under their parent, roots at top", () => {
    let s = spawn(INITIAL_STATE, "root");
    s = spawn(s, "child-1", { parentId: "root" });
    s = spawn(s, "child-2", { parentId: "root" });
    s = spawn(s, "grandchild", { parentId: "child-1" });
    const [tree] = orgForest(s);
    expect(ids(tree.roots)).toEqual(["root"]);
    expect(ids(tree.roots[0].children)).toEqual(["child-1", "child-2"]);
    expect(ids(tree.roots[0].children[0].children)).toEqual(["grandchild"]);
  });

  it("treats an agent with an unknown parentId as a root", () => {
    let s = spawn(INITIAL_STATE, "orphan", { parentId: "never-existed" });
    s = spawn(s, "root");
    expect(ids(orgForest(s)[0].roots)).toEqual(["orphan", "root"]);
  });

  it("promotes children of a despawned parent to roots", () => {
    let s = spawn(INITIAL_STATE, "root");
    s = spawn(s, "child", { parentId: "root" });
    s = apply(s, { type: "agent_despawned", agentId: "root", reason: null });
    const [tree] = orgForest(s);
    expect(ids(tree.roots)).toEqual(["child"]);
    expect(tree.counts.total).toBe(1);
  });

  it("excludes despawned agents entirely", () => {
    let s = spawn(INITIAL_STATE, "gone");
    s = apply(s, { type: "agent_despawned", agentId: "gone", reason: null });
    expect(orgForest(s)).toEqual([]);
  });

  it("counts total / working / blocked / done per repo", () => {
    let s = INITIAL_STATE;
    for (const id of ["w", "r", "b", "e", "d", "i"]) s = spawn(s, id);
    s = setStatus(s, "w", "working");
    s = setStatus(s, "r", "reading"); // active → working bucket
    s = setStatus(s, "b", "blocked");
    s = setStatus(s, "e", "error"); // alert → blocked bucket
    s = setStatus(s, "d", "done");
    // "i" stays idle: only in total
    const [tree] = orgForest(s);
    expect(tree.counts).toEqual({ total: 6, working: 2, blocked: 2, done: 1 });
  });

  it("groups per repo (sorted) and roots a child whose parent is in another repo", () => {
    let s = spawn(INITIAL_STATE, "root-b", { repo: "repo-b" });
    s = spawn(s, "root-a", { repo: "repo-a" });
    s = spawn(s, "stray", { parentId: "root-b", repo: "repo-a" });
    const forest = orgForest(s);
    expect(forest.map((t) => t.repo)).toEqual(["repo-a", "repo-b"]);
    expect(ids(forest[0].roots)).toEqual(["root-a", "stray"]);
    expect(ids(forest[1].roots)).toEqual(["root-b"]);
  });
});
