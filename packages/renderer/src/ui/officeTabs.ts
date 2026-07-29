import type { OfficeState } from "../sim/model";
import { repoTabs } from "../sim/selectors";

/** Tab key: "all" or a repo name. Kept distinct so a repo named "all" can't collide. */
export type TabKey = { kind: "all" } | { kind: "repo"; repo: string };

export const TAB_ALL: TabKey = { kind: "all" };

export interface OfficeTabs {
  render(state: OfficeState): void;
  /** Currently selected tab (falls back to "all" when its repo's tab closed). */
  readonly active: TabKey;
  /** Programmatic switch (intervention queue: jump to the alert's repo). */
  select(key: TabKey): void;
}

/**
 * Office tab bar — "All" plus one tab per repo with live characters.
 * Badge = live character count; red dot = some agent there needs the human.
 * Tabs close on their own once a repo has been empty past TAB_LINGER_MS.
 */
export function mountOfficeTabs(root: HTMLElement, onChange: (key: TabKey) => void): OfficeTabs {
  root.classList.add("office-tabs");
  let active: TabKey = TAB_ALL;
  let lastSig = "";

  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (!el) return;
    setActive(el.dataset.tab === "" ? TAB_ALL : { kind: "repo", repo: el.dataset.tab! });
  });

  function setActive(key: TabKey): void {
    active = key;
    onChange(key);
  }

  /** Update one tab button's badge / alert dot / active highlight in place. */
  function syncButton(el: HTMLElement, count: number, alert: boolean, isActive: boolean): void {
    el.querySelector(".badge")!.textContent = String(count);
    el.querySelector<HTMLElement>(".alert-dot")!.classList.toggle("on", alert);
    el.classList.toggle("active", isActive);
  }

  return {
    get active() {
      return active;
    },
    select: setActive,
    render(state: OfficeState): void {
      const tabs = repoTabs(state, Date.now());

      // active repo's tab closed (empty past linger) -> snap back to All
      if (active.kind === "repo") {
        const repo = active.repo;
        if (!tabs.some((t) => t.repo === repo)) setActive(TAB_ALL);
      }

      // DOM is only rebuilt when the tab SET changes; badges / alert dots /
      // the active highlight update in place — so a click can't land on a
      // button that a timer render just detached (same trick as the queue).
      const sig = tabs.map((t) => t.repo).join("|");
      if (sig !== lastSig) {
        lastSig = sig;
        root.innerHTML =
          tabButton("", "All") + tabs.map((t) => tabButton(t.repo, t.repo)).join("");
      }

      const total = [...state.agents.values()].filter((a) => a.despawnedAt === null).length;
      const anyAlert = tabs.some((t) => t.hasAlert);
      const activeRepo = active.kind === "repo" ? active.repo : "";
      for (const el of root.querySelectorAll<HTMLElement>("[data-tab]")) {
        const tab = tabs.find((t) => t.repo === el.dataset.tab);
        if (el.dataset.tab === "") syncButton(el, total, anyAlert, activeRepo === "");
        else if (tab) syncButton(el, tab.liveCount, tab.hasAlert, activeRepo === tab.repo);
      }
    },
  };
}

function tabButton(tabAttr: string, label: string): string {
  return `
    <button data-tab="${esc(tabAttr)}">
      <span class="label">${esc(label)}</span>
      <span class="badge"></span>
      <span class="alert-dot"></span>
    </button>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
