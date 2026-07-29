// Mini kanban on the office wall: in_progress / blocked / done counts from
// the work registry, click to expand the item list with deep links. Plain
// DOM like the other Mission Control panels. Fetches on mount and on each
// expand — no polling.

import { workItemLinksHtml, type WorkItem, type WorkItemsFile } from "./workItems";

export function mountBoard(
  root: HTMLElement,
  fetchWorkItems?: () => Promise<WorkItemsFile>,
): void {
  if (!fetchWorkItems) {
    root.hidden = true; // mock mode — no registry to show
    return;
  }
  root.classList.add("board");
  let items: WorkItem[] = [];
  let open = false;

  function render(): void {
    const count = (s: string) => items.filter((it) => it.status === s).length;
    const header = `<button class="board-toggle">Board · ${count("in_progress")} làm · ${count("blocked")} kẹt · ${count("done")} xong</button>`;
    const list = open
      ? `<ul class="board-list">${
          items
            .map(
              (it) =>
                `<li><span class="status-chip status-${esc(it.status ?? "unknown")}">${esc(it.status ?? "?")}</span> ${esc(it.title)} ${workItemLinksHtml(it)}</li>`,
            )
            .join("") || "<li>Registry trống.</li>"
        }</ul>`
      : "";
    root.innerHTML = header + list;
  }

  function refresh(): void {
    fetchWorkItems!()
      .then((file) => {
        items = file.items;
        render();
      })
      .catch(() => {
        /* daemon unreachable — keep last known counts */
      });
  }

  root.addEventListener("click", (ev) => {
    // Let deep links navigate; only the header toggles.
    if (!(ev.target as HTMLElement).closest(".board-toggle")) return;
    open = !open;
    render();
    if (open) refresh();
  });

  render();
  refresh();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
