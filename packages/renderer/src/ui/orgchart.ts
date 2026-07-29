import type { OfficeState } from "../sim/model";
import { orgForest, type OrgNode, type OrgRepoTree } from "../sim/selectors";
import type { TabKey } from "./officeTabs";

/**
 * "Sơ đồ tổ chức" — live org chart of who spawned whom. Root sessions are
 * department heads, sub-agents their reports. Plain DOM/CSS tree (no graph
 * lib); clicking a node closes the overlay and pans the camera to that
 * character (onSelect wired in main.ts, same path as the intervention queue).
 */
export function mountOrgChart(
  root: HTMLElement,
  getActiveTab: () => TabKey,
  getState: () => OfficeState,
  onSelect: (agentId: string) => void,
): void {
  root.classList.add("orgchart");
  root.innerHTML = `<button class="orgchart-toggle">Sơ đồ tổ chức</button><div class="orgchart-overlay" hidden></div>`;
  const overlay = root.querySelector<HTMLElement>(".orgchart-overlay")!;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSig = "";

  function render(): void {
    const tab = getActiveTab();
    const forest = orgForest(getState());
    const shown = tab.kind === "repo" ? forest.filter((t) => t.repo === tab.repo) : forest;
    // DOM only rebuilt when the tree changes (same trick as the queue panel)
    // so a click can't land on a node the refresh timer just detached.
    const sig =
      (tab.kind === "repo" ? tab.repo : "*") +
      shown
        .map((t) => t.repo + t.roots.map(nodeSig).join(""))
        .join("|");
    if (sig === lastSig) return;
    lastSig = sig;
    overlay.innerHTML = `
      <div class="orgchart-panel">
        <h2>Sơ đồ tổ chức <button class="orgchart-close" title="Đóng">✕</button></h2>
        ${shown.map(repoHtml).join("") || `<p class="empty">Chưa có agent nào đang chạy.</p>`}
      </div>`;
  }

  function close(): void {
    overlay.hidden = true;
    if (timer) clearInterval(timer);
    timer = null;
    lastSig = "";
  }

  root.querySelector(".orgchart-toggle")!.addEventListener("click", () => {
    overlay.hidden = false;
    render();
    // live update while open: agents spawn/despawn slowly, 1.5s is plenty
    timer = setInterval(render, 1_500);
  });

  overlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === overlay || target.closest(".orgchart-close")) {
      close();
      return;
    }
    const node = target.closest<HTMLElement>("[data-agent-id]");
    if (node?.dataset.agentId) {
      close();
      onSelect(node.dataset.agentId);
    }
  });
}

function nodeSig(n: OrgNode): string {
  return `${n.agent.agentId}:${n.agent.status};${n.children.map(nodeSig).join("")}`;
}

function repoHtml(tree: OrgRepoTree): string {
  const c = tree.counts;
  return `
    <section class="org-repo">
      <h3>${esc(tree.repo)}
        <span class="org-counts">${c.total} agent · ${c.working} làm · ${c.blocked} kẹt · ${c.done} xong</span>
      </h3>
      <ul class="org-tree">${tree.roots.map(nodeHtml).join("")}</ul>
    </section>`;
}

function nodeHtml(n: OrgNode): string {
  const a = n.agent;
  const icon = a.harness === "codex" ? "🤖" : a.harness ? "✳" : "";
  return `
    <li>
      <span class="org-node" data-agent-id="${esc(a.agentId)}">
        ${icon ? `<span class="org-harness" title="${esc(a.harness!)}">${icon}</span>` : ""}
        <span class="org-name">${esc(a.name)}</span>
        <span class="status-chip status-${esc(a.status)}">${esc(a.status)}</span>
      </span>
      ${n.children.length ? `<ul>${n.children.map(nodeHtml).join("")}</ul>` : ""}
    </li>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
