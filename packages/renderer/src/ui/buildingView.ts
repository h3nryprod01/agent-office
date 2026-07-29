import type { OfficeState } from "../sim/model";
import { repoTabs, type RepoTab } from "../sim/selectors";

/**
 * "Tòa nhà" — every repo as a stacked floor. Opens from a button beside the
 * org chart; clicking a floor jumps to that repo's tab (onPickRepo wired in
 * main.ts, same select() path the intervention queue uses). Plain DOM/CSS —
 * no canvas, no raw markup injection: every dynamic string (repo name) goes in through
 * textContent / dataset, so a repo name can never become markup.
 */
export function mountBuildingView(
  root: HTMLElement,
  getState: () => OfficeState,
  now: () => number,
  onPickRepo: (repo: string) => void,
): void {
  root.classList.add("building");

  const toggle = document.createElement("button");
  toggle.className = "building-toggle";
  toggle.type = "button";
  toggle.textContent = "🏢 Tòa nhà";
  const overlay = document.createElement("div");
  overlay.className = "building-overlay";
  overlay.hidden = true;
  root.append(toggle, overlay);

  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSig = "";

  const render = (): void => {
    const tabs = repoTabs(getState(), now());
    // Rebuild only when the floor list actually changes — same guard as the
    // org chart, so a click can't land on a floor the refresh just detached.
    const sig = tabs.map((t) => `${t.repo}:${t.liveCount}:${t.hasAlert ? 1 : 0}`).join("|");
    if (sig === lastSig) return;
    lastSig = sig;
    overlay.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "building-panel";

    const h2 = document.createElement("h2");
    h2.textContent = "Tòa nhà ";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "building-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Đóng";
    h2.appendChild(closeBtn);
    panel.appendChild(h2);

    if (tabs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Chưa có phòng ban nào đang hoạt động.";
      panel.appendChild(empty);
    } else {
      for (const t of tabs) panel.appendChild(buildFloor(t));
    }
    overlay.appendChild(panel);
  };

  const close = (): void => {
    overlay.hidden = true;
    if (timer) clearInterval(timer);
    timer = null;
    lastSig = "";
  };

  toggle.addEventListener("click", () => {
    overlay.hidden = false;
    render();
    timer = setInterval(render, 1_500); // live while open, like the org chart
  });

  overlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === overlay || target.closest(".building-close")) {
      close();
      return;
    }
    const floor = target.closest<HTMLElement>(".floor");
    const repo = floor?.dataset.repo;
    if (repo) {
      close();
      onPickRepo(repo);
    }
  });
}

/** Classes + alert flag for one floor — pulled out so the marker logic is
 *  unit-testable without a DOM (the repo's tests are node, not jsdom). */
export interface FloorData {
  repo: string;
  classes: string;
  alert: boolean;
}

export function floorData(tab: RepoTab): FloorData {
  const classes = ["floor"];
  if (tab.liveCount > 0) classes.push("active");
  if (tab.hasAlert) classes.push("alert");
  return { repo: tab.repo, classes: classes.join(" "), alert: tab.hasAlert };
}

function buildFloor(tab: RepoTab): HTMLButtonElement {
  const data = floorData(tab);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = data.classes;
  btn.dataset.repo = tab.repo;

  const name = document.createElement("span");
  name.className = "floor-name";
  name.textContent = tab.repo;
  btn.appendChild(name);

  const count = document.createElement("span");
  count.className = "floor-count";
  count.textContent = `${tab.liveCount} agent`;
  btn.appendChild(count);

  if (tab.hasAlert) {
    const dot = document.createElement("span");
    dot.className = "floor-alert";
    dot.textContent = "●";
    dot.title = "có agent đang kẹt";
    btn.appendChild(dot);
  }
  return btn;
}
