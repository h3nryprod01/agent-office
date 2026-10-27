// lane L5: the row of chips above the chat box that switches between PMs — the repo PM of
// the active office tab (as before) and one chip per project PM. Pure helpers; chatBox.ts
// owns the DOM. A chip shows the PM's live state (a pulsing dot while it works) and how many
// finished replies you have not looked at.

export interface PmRow {
  slug: string;
  name: string;
  state: "idle" | "working";
  queued: number;
  unread: number;
  lastError: string | null;
}

/** Chat transcripts are keyed by repo name; project PMs get their own namespace. */
export const chatKeyFor = (slug: string): string => `pm:${slug}`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Fold one raw `pm_status` WS frame into the list. Anything else returns the same array. */
export function applyPmStatus(pms: PmRow[], frame: unknown): PmRow[] {
  const f = frame as { type?: string; meta?: { project?: string; state?: string; queued?: number; unread?: number } } | null;
  if (f?.type !== "pm_status" || typeof f.meta?.project !== "string") return pms;
  const { project, state, queued, unread } = f.meta;
  const patch = {
    state: state === "working" ? ("working" as const) : ("idle" as const),
    queued: Number(queued) || 0,
    unread: Number(unread) || 0,
  };
  if (!pms.some((p) => p.slug === project)) return [...pms, { slug: project, name: project, lastError: null, ...patch }];
  return pms.map((p) => (p.slug === project ? { ...p, ...patch } : p));
}

/** HTML for the chip row. Empty string when there is nothing to switch between. */
export function renderPmChips(pms: PmRow[], active: string | null, repoLabel: string): string {
  if (pms.length === 0) return "";
  const chip = (slug: string, label: string, p?: PmRow): string => {
    const on = (active ?? "") === slug;
    const classes = ["pm-chip", on ? "active" : "", p?.state === "working" ? "pm-working" : "", p?.lastError ? "pm-error" : ""]
      .filter(Boolean)
      .join(" ");
    const unread = p && p.unread > 0 && !on ? `<span class="pm-unread">${p.unread}</span>` : "";
    return `<button type="button" class="${classes}" data-pm="${esc(slug)}"><span class="pm-dot"></span>${esc(label)}${unread}</button>`;
  };
  return chip("", repoLabel) + pms.map((p) => chip(p.slug, p.name, p)).join("");
}
