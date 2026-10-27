// Right-click a character (or its desk): everything you can do with that agent in one place.

import { t } from "../i18n";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export interface AgentMenuAgent {
  agentId: string;
  name: string;
  /** what it is doing right now, e.g. "Bash: npm test" — shown at the top of the menu */
  doing: string | null;
  /** the resume command for a terminal, null when it cannot be built safely */
  resume: string | null;
}

export type AgentMenuAction = "details" | "folder" | "file" | "terminal" | "resume";

export interface AgentMenuHandle {
  open(agent: AgentMenuAgent, clientX: number, clientY: number): void;
  close(): void;
}

export function menuHtml(a: AgentMenuAgent): string {
  const item = (action: AgentMenuAction, label: string, enabled = true): string =>
    `<button type="button" role="menuitem" data-action="${action}"${enabled ? "" : " disabled"}>${esc(label)}</button>`;
  return (
    `<div class="am-head"><b>${esc(a.name)}</b>${a.doing ? `<code>${esc(a.doing)}</code>` : ""}</div>` +
    item("details", t("agentMenu.details")) +
    item("folder", t("agentMenu.folder")) +
    item("file", t("agentMenu.file")) +
    item("terminal", t("agentMenu.terminal")) +
    item("resume", t("agentMenu.resume"), a.resume !== null)
  );
}

export function mountAgentMenu(onAction: (action: AgentMenuAction, agent: AgentMenuAgent) => void): AgentMenuHandle {
  const el = document.createElement("div");
  el.className = "agent-menu";
  el.setAttribute("role", "menu");
  el.hidden = true;
  document.body.appendChild(el);
  let current: AgentMenuAgent | null = null;

  const close = (): void => {
    el.hidden = true;
    current = null;
  };
  el.addEventListener("click", (ev) => {
    const action = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action as AgentMenuAction | undefined;
    if (!action || !current) return;
    const agent = current;
    close();
    onAction(action, agent);
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!el.hidden && !el.contains(ev.target as Node)) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  return {
    open(agent, x, y) {
      current = agent;
      el.innerHTML = menuHtml(agent);
      el.hidden = false;
      // keep the menu on screen near the pointer
      const w = el.offsetWidth || 220;
      const h = el.offsetHeight || 200;
      el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
      el.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    },
    close,
  };
}
