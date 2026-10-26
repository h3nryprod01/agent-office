// lane L5: the all-projects screen. One card per project: its PM (idle / working / queued /
// unread), item counts, approvals waiting on a human, who the members are, which chat room
// it posts to — and, for an owner, how to add a member (a one-time pairing code to send to
// the Telegram bot). Pure render functions + a thin DOM binding, like kanban.ts.

import { t } from "../i18n";

export type Role = "owner" | "manager" | "viewer";

export interface OverviewPm {
  state: "idle" | "working";
  queued: number;
  unread: number;
  lastAt: number | null;
  lastText: string;
  lastError: string | null;
}

export interface OverviewMember {
  id: string;
  name: string;
  role: Role;
  channels: string[];
}

export interface OverviewProject {
  slug: string;
  name: string;
  template: string;
  pm: OverviewPm | null;
  items: { idea: number; doing: number; review: number; done: number; dropped: number };
  pendingApprovals: number;
  members: OverviewMember[];
  rooms: string[];
}

export interface PairingCode {
  code: string;
  expiresAt: number;
  role: Role;
}

export interface CardState {
  canManage: boolean;
  formOpen: boolean;
  code: PairingCode | null;
  telegramOn: boolean;
}

const ROLES: Role[] = ["manager", "viewer", "owner"];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function pmBadge(pm: OverviewPm | null): { kind: "idle" | "working" | "error"; label: string } {
  if (pm?.state === "working") {
    const waiting = pm.queued > 0 ? ` · ${t("projects.pmWaiting", { n: pm.queued })}` : "";
    return { kind: "working", label: `${t("projects.pmWorking")}${waiting}` };
  }
  if (pm?.lastError) return { kind: "error", label: t("projects.pmError") };
  return { kind: "idle", label: t("projects.pmIdle") };
}

/** Lower = needs a human sooner. */
export function attentionRank(p: OverviewProject): number {
  if (p.pendingApprovals > 0) return 0;
  if (p.pm?.state === "working") return 1;
  if ((p.pm?.unread ?? 0) > 0) return 2;
  return 3;
}

export function sortProjects(list: OverviewProject[]): OverviewProject[] {
  return [...list].sort((a, b) => attentionRank(a) - attentionRank(b) || a.name.localeCompare(b.name));
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function memberChip(member: OverviewMember, slug: string, canManage: boolean): string {
  // the role goes into a class name and an i18n key: never trust it to be one of the three
  const m = { ...member, role: (["owner", "manager", "viewer"] as const).find((r) => r === member.role) ?? "viewer" };
  const remove = canManage
    ? `<button type="button" class="po-x" data-remove-member="${esc(slug)}|${esc(m.id)}" title="${esc(t("projects.remove"))}">✕</button>`
    : "";
  const via = m.channels.length ? ` · ${m.channels.map((c) => esc(c)).join(", ")}` : "";
  return (
    `<li class="po-member role-${m.role}">` +
    `<span class="po-avatar">${esc(initials(m.name))}</span>` +
    `<span class="po-mname">${esc(m.name)}</span>` +
    `<span class="po-role">${esc(t(`projects.role.${m.role}` as "projects.role.owner"))}${via}</span>` +
    `${remove}</li>`
  );
}

function memberForm(slug: string, code: PairingCode | null): string {
  const options = ROLES.map(
    (r) => `<option value="${r}">${esc(t(`projects.role.${r}` as "projects.role.owner"))} — ${esc(t(`projects.roleHelp.${r}` as "projects.roleHelp.owner"))}</option>`,
  ).join("");
  const shown = code
    ? `<div class="po-code"><div class="po-code-label">${esc(t("projects.codeFor", { role: t(`projects.role.${code.role}` as "projects.role.owner") }))}</div>` +
      `<code>${esc(code.code)}</code>` +
      `<p>${esc(t("projects.codeHint", { code: code.code, time: new Date(code.expiresAt).toLocaleTimeString() }))}</p></div>`
    : "";
  return (
    `<div class="po-form"><select class="po-role-pick" data-slug="${esc(slug)}">${options}</select>` +
    `<button type="button" class="po-btn" data-make-code="${esc(slug)}">${esc(t("projects.makeCode"))}</button>${shown}</div>`
  );
}

export function renderProjectCard(p: OverviewProject, s: CardState): string {
  const badge = pmBadge(p.pm);
  const unread = (p.pm?.unread ?? 0) > 0 ? `<span class="po-unread">${esc(t("projects.unread", { n: p.pm!.unread }))}</span>` : "";
  const approvals =
    p.pendingApprovals > 0
      ? `<div class="po-approvals">⚠ ${esc(t("projects.approvals", { n: p.pendingApprovals }))}</div>`
      : "";
  const it = p.items;
  const members = p.members.length
    ? `<ul class="po-members">${p.members.map((m) => memberChip(m, p.slug, s.canManage)).join("")}</ul>`
    : `<p class="po-muted">${esc(t("projects.noMembers"))}</p>`;
  const add = s.canManage
    ? `<button type="button" class="po-btn ghost" data-add-member="${esc(p.slug)}">＋ ${esc(t("projects.addMember"))}</button>` +
      (s.formOpen ? memberForm(p.slug, s.code) : "")
    : "";
  const room = !s.telegramOn
    ? `<p class="po-muted">${esc(t("projects.telegramOff"))}</p>`
    : p.rooms.length
      ? `<p class="po-rooms">💬 ${p.rooms.map((r) => esc(t(`projects.room.${r}` as "projects.room.telegram"))).join(" · ")}</p>`
      : `<p class="po-muted">${esc(t("projects.noRoom", { slug: p.slug }))}</p>`;
  return (
    `<article class="po-card" data-slug="${esc(p.slug)}">` +
    `<header><h3>${esc(p.name)}</h3><span class="po-tpl">${esc(p.template)}</span></header>` +
    `<div class="po-pm"><span class="po-pill pm-${badge.kind}">${esc(badge.label)}</span>${unread}` +
    `<button type="button" class="po-btn" data-open-pm="${esc(p.slug)}">${esc(t("projects.openPm"))}</button></div>` +
    approvals +
    `<p class="po-items">${esc(t("projects.items", { idea: it.idea, doing: it.doing, review: it.review, done: it.done }))}</p>` +
    `<h4>${esc(t("projects.members"))}</h4>${members}${add}` +
    `<h4>${esc(t("projects.rooms"))}</h4>${room}` +
    `</article>`
  );
}

export interface OverviewOpts {
  fetchOverview?: () => Promise<{ projects: OverviewProject[] }>;
  fetchChannels?: () => Promise<{ channels: { telegram: { enabled: boolean } } }>;
  makeCode?: (project: string, role: Role) => Promise<{ code: string; expiresAt: number; role: Role }>;
  removeMember?: (project: string, id: string) => Promise<void>;
  /** "Open PM chat" — select that project's PM in the chat box. */
  onOpenPm?: (slug: string) => void;
  /** Wall clock, injectable for tests. */
  poll?: boolean;
}

export interface OverviewHandle {
  refresh(): Promise<void>;
}

/** Mount the overview into `root`. Live mode only — without fetchOverview it shows a placeholder. */
export function mountProjectsOverview(root: HTMLElement, opts: OverviewOpts): OverviewHandle {
  root.classList.add("projects-overview");
  const fetchOverview = opts.fetchOverview;
  if (!fetchOverview) {
    root.innerHTML = `<p class="po-muted">${esc(t("projects.loadFailed"))}</p>`;
    return { refresh: async () => {} };
  }
  const load = fetchOverview;
  let projects: OverviewProject[] = [];
  let telegramOn = false;
  let loaded = false;
  let failed = false;
  const formsOpen = new Set<string>();
  const codes = new Map<string, PairingCode>();
  let lastSig = "";

  function render(): void {
    const sig = JSON.stringify([projects, telegramOn, loaded, failed, [...formsOpen], [...codes]]);
    if (sig === lastSig) return; // 5s polling must not wipe a half-picked <select>
    lastSig = sig;
    const body = !loaded
      ? `<p class="po-muted">${esc(t("projects.loading"))}</p>`
      : failed
        ? `<p class="po-muted">${esc(t("projects.loadFailed"))}</p>`
        : projects.length === 0
          ? `<div class="po-empty">${esc(t("projects.empty"))}</div>`
          : `<div class="po-grid">${sortProjects(projects)
              .map((p) => renderProjectCard(p, { canManage: Boolean(opts.makeCode), formOpen: formsOpen.has(p.slug), code: codes.get(p.slug) ?? null, telegramOn }))
              .join("")}</div>`;
    root.innerHTML = `<h2>${esc(t("projects.title"))}</h2><p class="po-sub">${esc(t("projects.sub"))}</p>${body}`;
  }

  async function refresh(): Promise<void> {
    try {
      projects = (await load()).projects ?? [];
      failed = false;
      if (opts.fetchChannels) telegramOn = Boolean((await opts.fetchChannels().catch(() => null))?.channels?.telegram?.enabled);
    } catch {
      failed = true;
    }
    loaded = true;
    render();
  }

  root.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement;
    const open = el.closest<HTMLElement>("[data-open-pm]");
    if (open) return opts.onOpenPm?.(open.dataset.openPm!);
    const add = el.closest<HTMLElement>("[data-add-member]");
    if (add) {
      const slug = add.dataset.addMember!;
      if (!formsOpen.delete(slug)) formsOpen.add(slug);
      return render();
    }
    const make = el.closest<HTMLElement>("[data-make-code]");
    if (make && opts.makeCode) {
      const slug = make.dataset.makeCode!;
      const pick = root.querySelector<HTMLSelectElement>(`select.po-role-pick[data-slug="${CSS.escape(slug)}"]`);
      const role = (pick?.value ?? "manager") as Role;
      opts.makeCode(slug, role).then(
        (made) => {
          codes.set(slug, { code: made.code, expiresAt: made.expiresAt, role });
          render();
        },
        (err: unknown) => {
          window.alert(t("projects.codeFailed", { error: err instanceof Error ? err.message : String(err) }));
        },
      );
      return;
    }
    const rm = el.closest<HTMLElement>("[data-remove-member]");
    if (rm && opts.removeMember) {
      const [slug, id] = rm.dataset.removeMember!.split("|") as [string, string];
      const member = projects.find((p) => p.slug === slug)?.members.find((m) => m.id === id);
      if (!window.confirm(t("projects.removeConfirm", { name: member?.name ?? id, project: slug }))) return;
      opts.removeMember(slug, id).then(refresh, (err: unknown) => window.alert(String(err)));
    }
  });

  render();
  if (opts.poll !== false) setInterval(() => { if (root.offsetParent !== null) void refresh(); }, 5000);
  return { refresh };
}
