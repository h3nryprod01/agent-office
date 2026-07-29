// Work registry (company-protocol.md §2) — types, agent↔item matching, and
// the HTML fragments shared by the side panel and the mini board. Pure
// string-building so the match/render logic is unit-testable without DOM.

import { t } from "../i18n";
/** One entry of the daemon's GET /work-items payload. */
export interface WorkItem {
  id: string;
  title: string;
  assignee?: string | null;
  sessionId?: string | null;
  branch?: string | null;
  planeUrl?: string | null;
  pr?: string | null;
  obsidianNote?: string | null;
  status?: string | null;
  /** The parent work item. null/undefined means this is the root of the chain. */
  parentItemId?: string | null;
}

export interface WorkItemsFile {
  version: number;
  items: WorkItem[];
}

/**
 * Obsidian vault name = folder containing `.obsidian` on this machine
 * (verified: the basic-memory "ai-memory" project lives INSIDE vault
 * "2nBrain", so the protocol's `vault=AI-Memory` example was wrong).
 * `obsidianNote` is expected to be a vault-relative file path.
 */
export const OBSIDIAN_VAULT = "2nBrain";

/** What matchWorkItem needs to know about an agent (subset of AgentModel). */
export interface AgentIdentity {
  sessionId: string;
  name: string;
  role: string | null;
  cwd: string | null;
}

/**
 * Find the work item for an agent: exact sessionId first, then assignee vs
 * agent name/role (either containing the other), then branch-in-cwd.
 * ponytail: heuristics are best-effort — coordinator fills sessionId when it
 * knows it, and that path is exact.
 */
export function matchWorkItem(agent: AgentIdentity, items: WorkItem[]): WorkItem | null {
  const bySession = items.find((it) => it.sessionId && it.sessionId === agent.sessionId);
  if (bySession) return bySession;

  const hay = `${agent.name} ${agent.role ?? ""}`.toLowerCase();
  const byAssignee = items.find((it) => {
    const a = it.assignee?.toLowerCase();
    return !!a && (hay.includes(a) || a.includes(agent.name.toLowerCase()));
  });
  if (byAssignee) return byAssignee;

  const cwd = agent.cwd?.toLowerCase();
  if (!cwd) return null;
  return (
    items.find((it) => {
      const seg = it.branch?.split("/").pop()?.toLowerCase();
      return !!seg && cwd.includes(seg);
    }) ?? null
  );
}

/**
 * The chain of work items from `start` up to the root, following parentItemId,
 * ordered [start, parent, …, root]. Stops on a missing parent (an orphan) and on
 * a cycle — returning what it walked rather than looping forever.
 */
export function ancestryOf(start: WorkItem, items: readonly WorkItem[]): WorkItem[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const chain: WorkItem[] = [];
  const seen = new Set<string>();
  let cur: WorkItem | undefined = start;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined;
  }
  return chain;
}

/** Deep-link row: Plane (dimmed when offline), Obsidian + PR (hidden when null). */
export function workItemLinksHtml(item: WorkItem): string {
  const links: string[] = [];
  links.push(
    item.planeUrl
      ? `<a class="wi-link" href="${esc(item.planeUrl)}" target="_blank" rel="noopener">Plane</a>`
      : `<span class="wi-link wi-disabled" title="Plane offline">Plane</span>`,
  );
  if (item.obsidianNote) {
    const href = `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT)}&file=${encodeURIComponent(item.obsidianNote)}`;
    links.push(`<a class="wi-link" href="${esc(href)}">Obsidian</a>`);
  }
  if (item.pr) {
    links.push(`<a class="wi-link" href="${esc(item.pr)}" target="_blank" rel="noopener">PR</a>`);
  }
  return `<div class="wi-links">${links.join("")}</div>`;
}

/**
 * The "why" block: the chain of parent work items, reading as "doing A because
 * B because C". Empty when an item has no parent — there is nothing to explain.
 * Every title is escaped.
 */
export function whyChainHtml(item: WorkItem, items: readonly WorkItem[]): string {
  const chain = ancestryOf(item, items);
  if (chain.length <= 1) return "";
  const rows = chain
    .map(
      (it, i) =>
        `<div class="why-row">${i === 0 ? "" : '<span class="why-arrow">${t("work.because")}</span> '}${esc(it.title)}</div>`,
    )
    .join("");
  return `<div class="why-chain"><div class="why-label">${t("work.whyLabel")}</div>${rows}</div>`;
}

/**
 * "Work item" section of the side panel.
 * @param items undefined = mock mode; null = live mode, still loading.
 */
export function workItemSectionHtml(
  agent: AgentIdentity,
  items?: WorkItem[] | null,
): string {
  if (items === undefined) {
    return `<p class="placeholder">${t("work.liveOnly")}</p>`;
  }
  if (items === null) {
    return `<p class="placeholder">${t("panel.loading")}</p>`;
  }
  const item = matchWorkItem(agent, items);
  if (!item) {
    return `<p class="placeholder">${t("work.none")}</p>`;
  }
  const status = item.status ?? "unknown";
  return `
    <div class="work-item">
      <div class="wi-title">${esc(item.title)}</div>
      <div class="wi-meta"><span class="status-chip status-${esc(status)}">${esc(status)}</span>${item.branch ? ` · <code>${esc(item.branch)}</code>` : ""}</div>
      ${workItemLinksHtml(item)}
      ${whyChainHtml(item, items)}
    </div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
