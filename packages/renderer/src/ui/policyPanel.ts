// lane L2: "Approvals & data rules" block of the Settings view.
//   - per project: approval mode (+ per-tool / per-role exceptions), allowed
//     harnesses and lanes, Save
//   - the audit log of everything the policy decided on its own
// The HTML builders are pure (unit-tested); mountPolicyPanel only wires events.
// Every dynamic string goes through esc() before it reaches innerHTML.

import { getLang, t } from "../i18n";
import { esc, isPolicyMode, modeBadgeHtml, modeLabel, POLICY_MODES, whyText, type PolicyMode } from "./policyLabels";

export const KNOWN_HARNESSES = ["claude", "codex", "gemini", "claude-worker", "hermes"] as const;

export interface PolicyBody {
  approval: { mode: PolicyMode; roles: Record<string, PolicyMode>; tools: Record<string, PolicyMode> };
  allowedHarnesses: string[] | null;
  allowedLanes: string[] | null;
}

export interface ProjectPolicy {
  slug: string;
  name: string;
  cwd: string;
  /** The repo name the office tabs use for this project's directory. */
  repo: string;
  hasPolicy: boolean;
  policy: PolicyBody;
}

export interface AuditRow {
  ts: number;
  project: string;
  sessionId?: string;
  agent: string;
  harness: string;
  lane: string | null;
  role?: string | null;
  tool: string;
  preview: string;
  mode: string;
  modeSource?: string;
  decision: "allow" | "deny" | "ask";
  reasons: string[];
  forced: string | null;
}

export interface SaveResult {
  ok: boolean;
  status: number;
}

/** What the form edits, kept apart from the saved policy until Save. */
export interface Draft {
  mode: PolicyMode;
  tools: Record<string, PolicyMode>;
  roles: Record<string, PolicyMode>;
  harnesses: string[];
  lanes: string;
}

export const draftFrom = (p: ProjectPolicy): Draft => ({
  mode: p.policy.approval.mode,
  tools: { ...p.policy.approval.tools },
  roles: { ...p.policy.approval.roles },
  harnesses: [...(p.policy.allowedHarnesses ?? [])],
  lanes: (p.policy.allowedLanes ?? []).join(", "),
});

const splitList = (text: string): string[] =>
  text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/** The body POST /policy expects. Empty lists mean "no rule" → null. */
export function buildPolicyPayload(d: Draft): PolicyBody {
  const lanes = splitList(d.lanes);
  return {
    approval: { mode: d.mode, roles: d.roles, tools: d.tools },
    allowedHarnesses: d.harnesses.length > 0 ? d.harnesses : null,
    allowedLanes: lanes.length > 0 ? lanes : null,
  };
}

function modeSelectHtml(value: PolicyMode, attrs: string): string {
  const options = POLICY_MODES.map(
    (m) => `<option value="${m}"${m === value ? " selected" : ""}>${esc(modeLabel(m))}</option>`,
  ).join("");
  return `<select ${attrs}>${options}</select>`;
}

function overridesHtml(kind: "tools" | "roles", map: Record<string, PolicyMode>): string {
  const entries = Object.entries(map);
  const chips = entries.length
    ? entries
        .map(
          ([name, mode]) =>
            `<span class="policy-override">${esc(name)} → ${esc(modeLabel(mode))}` +
            `<button type="button" class="policy-x" data-remove="${kind}" data-name="${esc(name)}" title="${esc(t("policy.overrides.remove"))}">×</button></span>`,
        )
        .join("")
    : `<span class="set-note">${esc(t("policy.overrides.none"))}</span>`;
  const placeholder = t(kind === "tools" ? "policy.overrides.toolPlaceholder" : "policy.overrides.rolePlaceholder");
  return (
    `<div class="policy-line"><span class="policy-line-label">${esc(t(kind === "tools" ? "policy.overrides.tools" : "policy.overrides.roles"))}</span>` +
    `<span class="policy-overrides">${chips}</span></div>` +
    `<div class="policy-line policy-add"><input type="text" data-add-name="${kind}" placeholder="${esc(placeholder)}" maxlength="80" />` +
    modeSelectHtml("ask", `data-add-mode="${kind}"`) +
    `<button type="button" class="set-probe" data-add="${kind}">${esc(t("policy.overrides.add"))}</button></div>`
  );
}

/** One project's card. `status` is the line under the Save button. */
export function projectCardHtml(p: ProjectPolicy, d: Draft, status = ""): string {
  const extraHarnesses = d.harnesses.filter((h) => !(KNOWN_HARNESSES as readonly string[]).includes(h));
  const harnessBoxes = [...KNOWN_HARNESSES, ...extraHarnesses].map(
    (h) =>
      `<label class="policy-check"><input type="checkbox" data-harness="${h}"${d.harnesses.includes(h) ? " checked" : ""} /> ${esc(h)}</label>`,
  ).join("");
  return (
    `<div class="policy-card" data-slug="${esc(p.slug)}">` +
    `<div class="policy-card-head"><strong>${esc(p.name)}</strong> ${modeBadgeHtml(p.policy.approval.mode)}` +
    `<span class="policy-path">${esc(p.cwd)}</span></div>` +
    `<div class="policy-line"><span class="policy-line-label">${esc(t("policy.mode"))}</span>` +
    modeSelectHtml(d.mode, "data-mode") +
    `</div><p class="set-hint policy-help" data-help>${esc(t(`policy.modeHelp.${d.mode}` as never))}</p>` +
    `<div class="policy-sub">${esc(t("policy.overrides"))}</div>` +
    overridesHtml("tools", d.tools) +
    overridesHtml("roles", d.roles) +
    `<div class="policy-sub">${esc(t("policy.harnesses"))}</div>` +
    `<div class="policy-line">${harnessBoxes}</div>` +
    `<p class="set-hint">${esc(t("policy.harnessesAny"))}</p>` +
    `<div class="policy-line"><span class="policy-line-label">${esc(t("policy.lanes"))}</span>` +
    `<input type="text" data-lanes value="${esc(d.lanes)}" placeholder="${esc(t("policy.lanesPlaceholder"))}" maxlength="200" /></div>` +
    `<p class="set-hint">${esc(t("policy.dataHint"))}</p>` +
    `<div class="policy-line"><button type="button" class="set-probe policy-save" data-save>${esc(t("policy.save"))}</button>` +
    `<span class="policy-status" data-status>${esc(status)}</span></div>` +
    `</div>`
  );
}

export function auditTableHtml(rows: AuditRow[]): string {
  if (rows.length === 0) return `<p class="set-note">${esc(t("policy.audit.empty"))}</p>`;
  const locale = getLang() === "vi" ? "vi-VN" : "en-GB";
  const head = (["when", "project", "agent", "tool", "mode", "decision", "why"] as const)
    .map((c) => `<th>${esc(t(`policy.audit.${c}` as never))}</th>`)
    .join("");
  const body = rows
    .map((r) => {
      const who = [r.agent, r.harness !== "claude" ? r.harness : "", r.lane ?? ""].filter(Boolean).join(" · ");
      return (
        `<tr class="decision-${esc(r.decision)}">` +
        `<td>${esc(new Date(r.ts).toLocaleString(locale))}</td>` +
        `<td>${esc(r.project)}</td>` +
        `<td>${esc(who)}</td>` +
        `<td title="${esc(r.preview)}"><strong>${esc(r.tool)}</strong> <span class="policy-preview">${esc(r.preview)}</span></td>` +
        `<td>${modeBadgeHtml(r.mode)}</td>` +
        `<td><span class="policy-decision ${esc(r.decision)}">${esc(t(`policy.decision.${r.decision}` as never))}</span></td>` +
        `<td>${esc(whyText(r.forced, r.reasons))}</td>` +
        `</tr>`
      );
    })
    .join("");
  return `<table class="policy-audit"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export interface PolicyPanelDeps {
  fetchPolicies: () => Promise<ProjectPolicy[]>;
  savePolicy: (slug: string, policy: PolicyBody) => Promise<SaveResult>;
  fetchAudit: (slug: string | null) => Promise<AuditRow[]>;
  /** Called after every successful refresh with repo name → mode (feeds the office-tab badges). */
  onModes?: (modes: Map<string, PolicyMode>) => void;
}

export interface PolicyPanelHandle {
  /** Re-fetch everything and redraw (when the Settings view opens, after Save). */
  refresh(): Promise<void>;
  /** Re-fetch the modes only and tell onModes — never redraws, so unsaved edits survive. */
  refreshModes(): Promise<void>;
}

export function mountPolicyPanel(root: HTMLElement, deps: PolicyPanelDeps): PolicyPanelHandle {
  root.classList.add("policy-panel");
  let projects: ProjectPolicy[] = [];
  let loaded = false;
  let auditFilter: string | null = null;
  let audit: AuditRow[] = [];
  const drafts = new Map<string, Draft>();

  const cardOf = (el: HTMLElement) => el.closest<HTMLElement>(".policy-card");
  const projectOf = (card: HTMLElement) => projects.find((p) => p.slug === card.dataset.slug);

  /** Copy what is typed/ticked in the card into its draft (before any re-render of that card). */
  function syncDraft(card: HTMLElement): Draft | null {
    const p = projectOf(card);
    if (!p) return null;
    const d = drafts.get(p.slug) ?? draftFrom(p);
    const mode = card.querySelector<HTMLSelectElement>("[data-mode]")?.value;
    if (isPolicyMode(mode)) d.mode = mode;
    // names outside KNOWN_HARNESSES (a hand-edited "aider") get their own checkbox in projectCardHtml, so they are read back here too
    d.harnesses = [...card.querySelectorAll<HTMLInputElement>("[data-harness]:checked")].map((i) => i.dataset.harness!);
    d.lanes = card.querySelector<HTMLInputElement>("[data-lanes]")?.value ?? d.lanes;
    drafts.set(p.slug, d);
    return d;
  }

  function renderCard(card: HTMLElement, status = ""): void {
    const p = projectOf(card);
    if (!p) return;
    card.outerHTML = projectCardHtml(p, drafts.get(p.slug) ?? draftFrom(p), status);
  }

  function render(): void {
    const auditOptions =
      `<option value="">${esc(t("policy.audit.all"))}</option>` +
      projects.map((p) => `<option value="${esc(p.slug)}"${p.slug === auditFilter ? " selected" : ""}>${esc(p.name)}</option>`).join("");
    const cards = !loaded
      ? ""
      : projects.length === 0
        ? `<p class="set-note">${esc(t("policy.noProjects"))}</p>`
        : projects.map((p) => projectCardHtml(p, drafts.get(p.slug) ?? draftFrom(p))).join("");
    root.innerHTML =
      `<section class="set-block"><h2>${esc(t("policy.title"))}</h2>` +
      `<p class="set-hint">${esc(t("policy.hint"))}</p><p class="set-hint">${esc(t("policy.hookNote"))}</p>${cards}</section>` +
      `<section class="set-block"><h2>${esc(t("policy.audit.title"))}</h2>` +
      `<div class="policy-line"><select data-audit-filter>${auditOptions}</select>` +
      `<button type="button" class="set-probe" data-audit-refresh>${esc(t("policy.audit.refresh"))}</button></div>` +
      `<div data-audit>${auditTableHtml(audit)}</div></section>`;
  }

  async function loadAudit(): Promise<void> {
    try {
      audit = await deps.fetchAudit(auditFilter);
    } catch {
      audit = [];
    }
    const box = root.querySelector("[data-audit]");
    if (box) box.innerHTML = auditTableHtml(audit);
  }

  root.addEventListener("change", (ev) => {
    const el = ev.target as HTMLElement;
    if (el.matches("[data-audit-filter]")) {
      auditFilter = (el as HTMLSelectElement).value || null;
      void loadAudit();
      return;
    }
    if (el.matches("[data-mode]")) {
      const card = cardOf(el);
      const d = card && syncDraft(card);
      const help = card?.querySelector("[data-help]");
      if (d && help) help.textContent = t(`policy.modeHelp.${d.mode}` as never);
    }
  });

  root.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement;
    if (el.closest("[data-audit-refresh]")) {
      void loadAudit();
      return;
    }
    const card = cardOf(el);
    if (!card) return;
    const d = syncDraft(card);
    const p = projectOf(card);
    if (!d || !p) return;

    const remove = el.closest<HTMLElement>("[data-remove]");
    if (remove) {
      delete d[remove.dataset.remove as "tools" | "roles"][remove.dataset.name!];
      renderCard(card);
      return;
    }
    const add = el.closest<HTMLElement>("[data-add]");
    if (add) {
      const kind = add.dataset.add as "tools" | "roles";
      const name = card.querySelector<HTMLInputElement>(`[data-add-name="${kind}"]`)?.value.trim() ?? "";
      const mode = card.querySelector<HTMLSelectElement>(`[data-add-mode="${kind}"]`)?.value;
      if (name && isPolicyMode(mode)) d[kind][name] = mode;
      renderCard(card);
      return;
    }
    if (el.closest("[data-save]")) {
      const status = card.querySelector<HTMLElement>("[data-status]");
      if (status) status.textContent = t("policy.saving");
      deps
        .savePolicy(p.slug, buildPolicyPayload(d))
        .then(async (res) => {
          if (res.ok) {
            drafts.delete(p.slug);
            await refresh();
            const fresh = root.querySelector<HTMLElement>(`.policy-card[data-slug="${CSS.escape(p.slug)}"] [data-status]`);
            if (fresh) fresh.textContent = t("policy.saved");
          } else if (status) {
            status.textContent = res.status === 403 ? t("policy.needOwner") : t("policy.saveFailed", { status: res.status });
          }
        })
        .catch(() => {
          if (status) status.textContent = t("policy.saveFailed", { status: "network" });
        });
    }
  });

  async function refreshModes(): Promise<boolean> {
    try {
      projects = await deps.fetchPolicies();
      loaded = true;
      const modes = new Map<string, PolicyMode>();
      for (const p of projects) if (!modes.has(p.repo)) modes.set(p.repo, p.policy.approval.mode);
      deps.onModes?.(modes);
      return true;
    } catch {
      return false; // daemon offline: keep what is on screen
    }
  }

  async function refresh(): Promise<void> {
    if (!(await refreshModes())) return;
    try {
      audit = await deps.fetchAudit(auditFilter);
    } catch {
      audit = [];
    }
    render();
  }

  render();
  return { refresh, refreshModes: async () => void (await refreshModes()) };
}
