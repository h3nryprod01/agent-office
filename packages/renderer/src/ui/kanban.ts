// R13-B: Kanban board — two sub-tabs over one items.json:
//   "Ý tưởng của tôi" (source=human) / "Việc của agent" (source=agent).
// Pure helpers (groupByStatus, forTab, columnCards, COLUMNS) are exported so the
// layout/filter logic is unit-testable with no DOM and no network. mountKanban
// is the DOM binding; it fetches via the injected fetchItems and writes new
// ideas via addItem (both live-mode only — mock degrades to a placeholder).

export type SubTab = "mine" | "agent";

export interface KanbanItem {
  id: string;
  title: string;
  source: string; // "human" | "agent"
  status: string; // idea|doing|review|done|dropped
}

/** [status, column label] per sub-tab. mine = a person's ideas; agent = chip work. */
export const COLUMNS: Record<SubTab, [string, string][]> = {
  mine: [
    ["idea", "Ý tưởng"],
    ["done", "Xong"],
  ],
  agent: [
    ["idea", "Chờ xử lý"],
    ["doing", "Đang làm"],
    ["review", "Chờ duyệt"],
    ["done", "Xong"],
  ],
};

const DONE_LIMIT = 3;
const SOURCE_BADGE: Record<string, string> = { human: "👤", agent: "🤖" };

/** Group items into a Map keyed by status. Pure. */
export function groupByStatus(items: KanbanItem[]): Map<string, KanbanItem[]> {
  const m = new Map<string, KanbanItem[]>();
  for (const it of items) {
    const arr = m.get(it.status);
    if (arr) arr.push(it);
    else m.set(it.status, [it]);
  }
  return m;
}

/** Items visible in a sub-tab — mine filters to source=human, agent to source=agent. Pure. */
export function forTab(items: KanbanItem[], tab: SubTab): KanbanItem[] {
  const source = tab === "mine" ? "human" : "agent";
  return items.filter((i) => i.source === source);
}

/** Cards to render in one column. The "done" column truncates to DONE_LIMIT and
 *  reports how many were hidden ("… N thẻ nữa"). Pure. */
export function columnCards(
  items: KanbanItem[],
  status: string,
): { shown: KanbanItem[]; hidden: number } {
  const all = items.filter((i) => i.status === status);
  if (status === "done" && all.length > DONE_LIMIT) {
    return { shown: all.slice(0, DONE_LIMIT), hidden: all.length - DONE_LIMIT };
  }
  return { shown: all, hidden: 0 };
}

/** An idea a person wrote is "assignable" to the PM (gets a Giao cho PM button);
 *  agent work and ideas already moved past "idea" are not. Pure. */
export function assignableId(it: KanbanItem): string | null {
  return it.source === "human" && it.status === "idea" ? it.id : null;
}

export interface KanbanHandle {
  refresh(): Promise<void>;
}

interface KanbanOpts {
  project: string;
  fetchItems?: (project: string, source?: string) => Promise<{ items: KanbanItem[] }>;
  addItem?: (body: { project: string; title: string; source: string }) => Promise<unknown>;
  /** "Giao cho PM" clicked on an assignable idea — pre-fill the PM chat. */
  onAssignToPM?: (item: KanbanItem) => void;
}

/**
 * Mount the kanban into `root`. Live mode only — mock (no fetchItems) shows a
 * placeholder and refresh() is a no-op.
 */
export function mountKanban(root: HTMLElement, opts: KanbanOpts): KanbanHandle {
  root.classList.add("kanban");
  const fetchItems = opts.fetchItems;
  let items: KanbanItem[] = [];
  let tab: SubTab = "mine";

  if (!fetchItems) {
    root.innerHTML = `<p class="kanban-placeholder">Bảng việc chỉ có ở live mode.</p>`;
    return { refresh: async () => {} };
  }
  // Rebind to a non-optional type so the narrowing survives into the closures
  // below (TS drops narrowing from the early-return guard inside nested functions).
  const loadItems = fetchItems;

  render();

  root.addEventListener("click", (ev) => {
    const assignEl = (ev.target as HTMLElement).closest<HTMLElement>("[data-assign]");
    if (assignEl) {
      const found = items.find((it) => it.id === assignEl.dataset.assign);
      if (found) opts.onAssignToPM?.(found);
      return;
    }
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (!el) return;
    tab = el.dataset.tab === "agent" ? "agent" : "mine";
    render();
  });

  root.addEventListener("keydown", (ev) => {
    if (!(ev.target instanceof HTMLInputElement)) return;
    if (ev.key !== "Enter") return;
    const input = ev.target as HTMLInputElement;
    const title = input.value.trim();
    if (!title || !opts.addItem) return;
    input.value = "";
    opts.addItem({ project: opts.project, title, source: "human" }).then(
      () => refresh(),
      (err) => console.error("[kanban] addItem failed:", err),
    );
  });

  async function refresh(): Promise<void> {
    try {
      const data = await loadItems(opts.project);
      items = data?.items ?? [];
    } catch (err) {
      console.error("[kanban] fetchItems failed:", err);
      items = [];
    }
    render();
  }

  function render(): void {
    const mine = forTab(items, "mine");
    const agent = forTab(items, "agent");
    const pool = tab === "mine" ? mine : agent;
    const boardHtml =
      pool.length === 0
        ? emptyState(tab)
        : `<div class="kanban-board">` +
          COLUMNS[tab]
            .map(([status, label]) => {
              const { shown, hidden } = columnCards(pool, status);
              const cards = shown.map(card).join("");
              const more = hidden > 0 ? `<p class="kanban-more">… ${hidden} thẻ nữa</p>` : "";
              return `<section class="kanban-col"><h3>${esc(label)}</h3>${cards}${more}</section>`;
            })
            .join("") +
          `</div>`;
    const input =
      tab === "mine"
        ? `<input class="kanban-input" type="text" placeholder="+ ghi nhanh một ý tưởng…" />`
        : "";
    // First-run (empty): stack guidance + input in one centered column so the
    // "ô bên dưới" is literally right below the message, not floating bottom-left.
    const body =
      pool.length === 0 ? `<div class="kanban-firstrun">${boardHtml}${input}</div>` : boardHtml + input;
    root.innerHTML =
      `<div class="kanban-tabs">` +
      tabButton("mine", "Ý tưởng của tôi", mine.length, tab === "mine") +
      tabButton("agent", "Việc của agent", agent.length, tab === "agent") +
      `</div>` +
      body;
  }

  return { refresh };
}

/** First-run / empty board: guidance + the next action, not a bare column grid.
 * `tab` picks the message (own ideas vs agent work). Exported for tests. */
export function emptyState(tab: SubTab): string {
  const [emoji, title, sub] =
    tab === "mine"
      ? ["💡", "Chưa có ý tưởng nào", "Gõ ý tưởng đầu tiên vào ô bên dưới rồi Enter — PM sẽ nhặt việc từ đây."]
      : ["📥", "Agent chưa có việc nào", "Sang tab “Ý tưởng của tôi”, ghi một ý rồi bấm “Giao cho PM”."];
  return (
    `<div class="kanban-empty">` +
    `<div class="kanban-empty-emoji">${emoji}</div>` +
    `<p class="kanban-empty-title">${esc(title)}</p>` +
    `<p class="kanban-empty-sub">${esc(sub)}</p>` +
    `</div>`
  );
}

function tabButton(key: SubTab, label: string, count: number, active: boolean): string {
  return (
    `<button class="kanban-tab${active ? " active" : ""}" type="button" data-tab="${key}">` +
    `<span class="kanban-tab-label">${esc(label)}</span>` +
    `<span class="kanban-count">${count}</span>` +
    `</button>`
  );
}

function card(it: KanbanItem): string {
  const badge = SOURCE_BADGE[it.source] ?? "";
  const assign = assignableId(it)
    ? `<button class="kanban-assign" type="button" data-assign="${esc(it.id)}">Giao cho PM</button>`
    : "";
  return (
    `<article class="kanban-card">` +
    `<span class="kanban-source" aria-hidden="true">${badge}</span>` +
    `<span class="kanban-title">${esc(it.title)}</span>` +
    assign +
    `</article>`
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
