// Approve / Deny right above the character that is waiting: the tool, the exact command (or
// file) it wants to run, why it was asked, and the two buttons. Same store and same
// /approval-response as the "Needs you" queue, so either place answers it.

import { t } from "../i18n";
import type { ApprovalsStore, PendingApproval } from "./approvals";

const PREVIEW_SHORT = 140;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export interface ApprovalCardsDeps {
  store: ApprovalsStore;
  /** agent id that owns an approval's session (the root agent of that session), if it is in the office */
  agentOf: (approval: PendingApproval) => { agentId: string; name: string } | null;
  /** where that agent's head is on screen, null when it is not in view */
  screenPos: (agentId: string) => { x: number; y: number } | null;
  /** cards only show over the 3D office */
  visible: () => boolean;
  now?: () => number;
}

export function cardHtml(a: PendingApproval, name: string, expanded: boolean, now: number): string {
  const long = a.preview.length > PREVIEW_SHORT;
  const shown = expanded || !long ? a.preview : `${a.preview.slice(0, PREVIEW_SHORT)}…`;
  const secs = Math.max(0, Math.round((a.expiresAt - now) / 1000));
  const why = a.policy?.forced ? `<div class="ac-why">${esc(t("approvalCard.why", { why: a.policy.forced }))}</div>` : "";
  return (
    `<div class="ac-head"><span class="ac-who">${esc(name)}</span> · <b>${esc(a.tool)}</b><span class="ac-secs" data-secs>${secs}s</span></div>` +
    (a.preview ? `<pre class="ac-cmd${long ? " ac-more" : ""}" data-expand title="${esc(long ? t("approvalCard.expand") : "")}">${esc(shown)}</pre>` : "") +
    why +
    `<div class="ac-btns"><button type="button" class="ac-allow" data-decision="allow">${esc(t("approvalCard.allow"))}</button>` +
    `<button type="button" class="ac-deny" data-decision="deny">${esc(t("approvalCard.deny"))}</button></div>`
  );
}

export function mountApprovalCards(root: HTMLElement, deps: ApprovalCardsDeps): { stop(): void } {
  root.classList.add("approval-cards");
  const now = deps.now ?? Date.now;
  const cards = new Map<string, HTMLElement>();
  const expanded = new Set<string>();
  let raf = 0;

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-approval]");
    if (!card) return;
    const id = card.dataset.approval!;
    const decision = target.closest<HTMLElement>("[data-decision]")?.dataset.decision;
    if (decision === "allow" || decision === "deny") {
      card.remove();
      cards.delete(id);
      void deps.store.respond(id, decision);
      return;
    }
    if (target.closest("[data-expand]")) {
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      card.dataset.sig = ""; // re-render with the full text
    }
  });

  function frame(): void {
    raf = requestAnimationFrame(frame);
    const show = deps.visible();
    const pending = show ? deps.store.list(now()) : [];
    const live = new Set<string>();
    for (const a of pending) {
      const who = deps.agentOf(a);
      if (!who) continue;
      const pos = deps.screenPos(who.agentId);
      let card = cards.get(a.id);
      if (!card) {
        card = document.createElement("div");
        card.className = "approval-card";
        card.dataset.approval = a.id;
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-label", t("approvalCard.aria", { name: who.name, tool: a.tool }));
        root.appendChild(card);
        cards.set(a.id, card);
      }
      live.add(a.id);
      const sig = `${who.name}|${a.preview}|${expanded.has(a.id)}`;
      if (card.dataset.sig !== sig) {
        card.innerHTML = cardHtml(a, who.name, expanded.has(a.id), now());
        card.dataset.sig = sig;
      } else {
        const secs = card.querySelector<HTMLElement>("[data-secs]");
        if (secs) secs.textContent = `${Math.max(0, Math.round((a.expiresAt - now()) / 1000))}s`;
      }
      card.hidden = !pos;
      if (pos) card.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px) translate(-50%, -100%)`;
    }
    for (const [id, card] of cards) {
      if (live.has(id)) continue;
      card.remove();
      cards.delete(id);
      expanded.delete(id);
    }
  }
  raf = requestAnimationFrame(frame);
  return { stop: () => cancelAnimationFrame(raf) };
}
