// R13-B: left navbar rail — the app's top-level switch (Văn phòng / Bảng việc /
// Chi phí / Cấu hình). Pure DOM: it only knows its list of items and emits the
// picked key via onSelect. It does NOT know which panel each key maps to — the
// caller (main.ts) wires onSelect → setView, which shows/hides panels.

export interface NavItem {
  key: string;
  label: string;
  icon: string;
  badge?: number | string;
}

export interface NavbarHandle {
  /** Sync the active highlight to `key`. Visual only — does NOT re-fire onSelect. */
  select(key: string): void;
}

/**
 * Mount the vertical nav rail into `root`.
 * @param items  one button per item, in order
 * @param active key highlighted at mount
 * @param onSelect fired on click with the item's key
 */
export function mountNavbar(
  root: HTMLElement,
  { items, active, onSelect }: { items: NavItem[]; active?: string; onSelect: (key: string) => void },
): NavbarHandle {
  let current = active ?? items[0]?.key ?? "";
  root.classList.add("navbar");
  root.innerHTML = items.map(navButton).join("");
  syncActive();

  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-nav]");
    if (!el) return;
    const key = el.dataset.nav!;
    current = key;
    syncActive();
    onSelect(key);
  });

  function syncActive(): void {
    for (const el of root.querySelectorAll<HTMLElement>("[data-nav]")) {
      const on = el.dataset.nav === current;
      el.setAttribute("aria-current", on ? "page" : "false");
      el.classList.toggle("active", on);
    }
  }

  return { select: (key: string) => { current = key; syncActive(); } };
}

function navButton(item: NavItem): string {
  const badge =
    item.badge !== undefined
      ? `<span class="nav-badge">${esc(String(item.badge))}</span>`
      : "";
  return (
    `<button class="nav-item" type="button" data-nav="${esc(item.key)}" aria-current="false" title="${esc(item.label)}">` +
    `<span class="nav-icon">${esc(item.icon)}</span>` +
    `<span class="nav-label">${esc(item.label)}</span>` +
    `${badge}` +
    `</button>`
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
