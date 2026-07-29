import type { AgentStatus } from "../../../protocol/src/events";
import { type AgentModel, type OfficeState, isAlertStatus } from "./model";

/**
 * Mission Control ordering: which alert deserves the human first.
 * Lower rank = higher priority (semantic-mapping.md §5).
 */
const ALERT_RANK: Partial<Record<AgentStatus, number>> = {
  waiting_permission: 0,
  error: 1,
  blocked: 2,
};

/**
 * Agents that need the human NOW, most urgent first; ties broken by who has
 * been stuck the longest. This is the data behind the intervention queue
 * panel — pure function so it's trivially testable.
 */
export function interventionQueue(state: OfficeState): AgentModel[] {
  return [...state.agents.values()]
    .filter((a) => a.despawnedAt === null && isAlertStatus(a.status))
    .sort((a, b) => {
      const rank = (ALERT_RANK[a.status] ?? 9) - (ALERT_RANK[b.status] ?? 9);
      return rank !== 0 ? rank : a.statusSince - b.statusSince;
    });
}

/** How long waiting_permission/blocked must hold before the CEO queue forms — filters out blips the intervention queue would still flag immediately. */
export const CEO_QUEUE_DELAY_MS = 10_000;

const CEO_QUEUE_STATUSES: ReadonlySet<AgentStatus> = new Set(["waiting_permission", "blocked"]);

/**
 * Agents walking to the CEO desk to wait on a decision — the visual queue
 * (wi-ceo-avatar), same OfficeState source as interventionQueue but a
 * stricter view: only genuine "waiting on a human call" statuses (no
 * `error`, nothing just broke), and debounced by CEO_QUEUE_DELAY_MS so a
 * brief block doesn't send a character marching across the office. FIFO by
 * statusSince — a physical line, not a priority list.
 */
export function ceoQueue(state: OfficeState, now: number): AgentModel[] {
  return [...state.agents.values()]
    .filter(
      (a) =>
        a.despawnedAt === null &&
        CEO_QUEUE_STATUSES.has(a.status) &&
        now - a.statusSince >= CEO_QUEUE_DELAY_MS,
    )
    .sort((a, b) => a.statusSince - b.statusSince);
}

/**
 * A repo tab stays open while it has live characters, and lingers this long
 * after its last character despawns so a finishing agent doesn't make the
 * tab vanish under the user's cursor.
 * ponytail: fixed 5 min; make it a setting if anyone ever asks.
 */
export const TAB_LINGER_MS = 5 * 60 * 1000;

/** What the office tab bar renders for one repo. */
export interface RepoTab {
  repo: string;
  /** Characters currently alive in this repo. */
  liveCount: number;
  /** True if any live agent is in an alert status (red dot on the tab). */
  hasAlert: boolean;
}

/**
 * Repos that deserve a tab right now: any repo with a live agent, or one
 * whose last agent despawned less than TAB_LINGER_MS ago. Stable order:
 * alphabetical, so tabs don't jump around as counts change.
 */
export function repoTabs(state: OfficeState, now: number): RepoTab[] {
  const tabs = new Map<string, RepoTab>();
  for (const a of state.agents.values()) {
    const live = a.despawnedAt === null;
    const lingering = a.despawnedAt !== null && now - a.despawnedAt < TAB_LINGER_MS;
    if (!live && !lingering) continue;
    const tab = tabs.get(a.repo) ?? { repo: a.repo, liveCount: 0, hasAlert: false };
    if (live) {
      tab.liveCount += 1;
      if (isAlertStatus(a.status)) tab.hasAlert = true;
    }
    tabs.set(a.repo, tab);
  }
  return [...tabs.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * The slice of state one office instance renders: only that repo's agents.
 * Cheap enough to run per frame (small maps); "all" callers skip it.
 */
export function filterStateByRepo(state: OfficeState, repo: string): OfficeState {
  const agents = new Map([...state.agents].filter(([, a]) => a.repo === repo));
  return { ...state, agents };
}

/** "43s" / "2m 05s" — how long an agent has been in its current status. */
export function formatSince(statusSince: number, now: number): string {
  const s = Math.max(0, Math.floor((now - statusSince) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** One node of the org chart: an agent and the sub-agents it spawned. */
export interface OrgNode {
  agent: AgentModel;
  children: OrgNode[];
}

export interface OrgCounts {
  total: number;
  working: number;
  blocked: number;
  done: number;
}

/** One repo's slice of the org chart (a "department"). */
export interface OrgRepoTree {
  repo: string;
  roots: OrgNode[];
  counts: OrgCounts;
}

/**
 * Org chart data: live agents grouped per repo, nested by parentId — root
 * sessions are department heads, sub-agents their reports. An agent whose
 * parent is missing, despawned, or lives in another repo becomes a root of
 * its own repo's tree (orphans must stay visible, not vanish). Child order =
 * spawn order (Map insertion order). Counts per repo: blocked = alert
 * statuses, working = actively doing something (idle only counts in total).
 */
export function orgForest(state: OfficeState): OrgRepoTree[] {
  const live = [...state.agents.values()].filter((a) => a.despawnedAt === null);
  const nodes = new Map<string, OrgNode>(
    live.map((a) => [a.agentId, { agent: a, children: [] }]),
  );
  const trees = new Map<string, OrgRepoTree>();
  for (const a of live) {
    let tree = trees.get(a.repo);
    if (!tree) {
      tree = { repo: a.repo, roots: [], counts: { total: 0, working: 0, blocked: 0, done: 0 } };
      trees.set(a.repo, tree);
    }
    const parent = a.parentId ? nodes.get(a.parentId) : undefined;
    if (parent && parent.agent.repo === a.repo) parent.children.push(nodes.get(a.agentId)!);
    else tree.roots.push(nodes.get(a.agentId)!);
    tree.counts.total += 1;
    if (isAlertStatus(a.status)) tree.counts.blocked += 1;
    else if (a.status === "done") tree.counts.done += 1;
    else if (a.status !== "idle") tree.counts.working += 1;
  }
  return [...trees.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}
