// Hiring Hall (wi-hiring-hall): click the reception desk → recruitment panel.
// (a) live roster by department from GET /roster (the daemon reads
//     ~/.claude/company/roster.yaml — members are INSTALLED skills/agents,
//     not live sessions);
// (b) "tuyển người mới" form → hands the gap to the repo's PM via the
//     existing POST /chat with a company-hire prompt. The PM runs the skill
//     (mandatory skillspector scan) — nothing here spawns processes or
//     bypasses the scan, and the PM's progress streams into the chatbox;
// (c) roster_updated frames (daemon file watcher) → diff members → new names
//     walk in through the office door for a 3s 👋 greeting (render-only).
//
// Raw daemon frames arrive through main.ts's WS raw-frame tap — the same
// path ApprovalsStore uses — so this opens no extra socket.

import { t } from "../i18n";
export interface RosterMember {
  name: string;
  role: string | null;
  hired: string | null;
  source: string | null;
  cv: Record<string, unknown> | null;
}

export interface RosterDept {
  name: string;
  budgetUsdPerDay: number | null;
  members: RosterMember[];
}

export interface RosterPayload {
  version: number | null;
  updated: string | null;
  departments: RosterDept[];
}

/** chat_message / roster_updated frames as seen on the raw WS tap. */
export interface RawRosterFrame {
  type?: string;
  ts?: number;
  repo?: string;
  meta?: {
    roster?: RosterPayload;
    role?: "user" | "assistant" | "system";
    text?: string;
    done?: boolean;
    error?: boolean;
  } | null;
}

const HTTP_BASE = "";

/** The exact turn handed to the PM — company-hire owns the process (scan bắt buộc). */
export function hirePrompt(gap: string): string {
  return t("hiring.prompt", { gap });
}

/**
 * Members present in `next` but not `prev` (by name, across departments).
 * `prev === null` = no baseline yet (first snapshot, daemon restart replay):
 * adopt silently, greet nobody.
 */
export function newMemberNames(prev: RosterPayload | null, next: RosterPayload): string[] {
  if (!prev) return [];
  const seen = new Set(prev.departments.flatMap((d) => d.members.map((m) => m.name)));
  const out: string[] = [];
  for (const dept of next.departments) {
    for (const m of dept.members) {
      if (!seen.has(m.name) && !out.includes(m.name)) out.push(m.name);
    }
  }
  return out;
}

/**
 * Frame → walk-in decision, extracted pure so the greeting path unit-tests
 * without DOM/WS. Returns the fresh roster + names to greet, or null when the
 * frame is not a fresh roster_updated (wrong type, no payload, or a WS
 * backlog replay older than page load).
 */
export function rosterFrameDiff(
  prev: RosterPayload | null,
  frame: RawRosterFrame,
  mountTs: number,
): { roster: RosterPayload; newNames: string[] } | null {
  if (frame.type !== "roster_updated" || !frame.meta?.roster) return null;
  if ((frame.ts ?? 0) <= mountTs) return null;
  const roster = frame.meta.roster;
  return { roster, newNames: newMemberNames(prev, roster) };
}

export function rosterHtml(roster: RosterPayload): string {
  const total = roster.departments.reduce((n, d) => n + d.members.length, 0);
  if (total === 0 && roster.departments.length === 0) {
    return `<p class="empty">${t("hiring.noRoster")}</p>`;
  }
  const depts = roster.departments
    .map((d) => {
      const budget = d.budgetUsdPerDay !== null ? `<span class="hh-budget">${t("hiring.budgetCap", { amount: d.budgetUsdPerDay })}</span>` : "";
      const rows = d.members
        .map((m) => {
          const scan = m.cv?.scan_verdict ? ` · scan: ${String(m.cv.scan_verdict)}` : "";
          const tip = `${m.source ?? ""}${scan}`.trim();
          return `<tr>
            <td class="hh-name" title="${esc(tip)}">${esc(m.name)}</td>
            <td class="hh-role">${esc(m.role ?? "")}</td>
            <td class="hh-hired">${m.hired ? `📅 ${esc(m.hired)}` : ""}</td>
          </tr>`;
        })
        .join("");
      return `<section class="hh-dept">
        <h3>${esc(d.name)} <span class="hh-count">(${d.members.length})</span> ${budget}</h3>
        ${d.members.length ? `<table class="hh-table">${rows}</table>` : `<p class="empty">${t("hiring.emptyDept")}</p>`}
      </section>`;
    })
    .join("");
  return `<p class="hh-updated">${t("hiring.rosterUpdated", { when: esc(roster.updated ?? "?"), total })}</p>${depts}`;
}

export interface HiringHallHandle {
  /** Open the panel (reception desk click). */
  open(): void;
  /** Active office tab changed; null = tab "All" → the daemon's default repo. */
  setRepo(repo: string | null): void;
  /** Raw daemon frame from the shared WS tap. */
  onRaw(frame: unknown): void;
}

export function mountHiringHall(
  root: HTMLElement,
  opts: {
    /** undefined = mock mode (no daemon): panel shows a hint, form disabled. */
    fetchRoster?: () => Promise<RosterPayload>;
    /** New roster member → walk-in greeting in the visible office. */
    walkIn: (name: string) => void;
  },
): HiringHallHandle {
  root.classList.add("hiring");
  root.innerHTML = `
    <div class="hiring-overlay" hidden>
      <div class="hiring-panel">
        <h2>${t("hiring.title")} <button class="hiring-close" title="${t("panel.close")}">✕</button></h2>
        <p class="hh-note">${t("hiring.note")}</p>
        <div class="hh-roster"><p class="empty">${t("hiring.loading")}</p></div>
        <h3 class="hh-form-title">${t("hiring.newHire")}</h3>
        <form class="hh-form">
          <input type="text" placeholder="${t("hiring.gapPlaceholder")}" />
          <button type="submit">${t("hiring.askPm")}</button>
        </form>
        <p class="hh-status" hidden></p>
        <p class="hh-note">${t("hiring.flow")}</p>
      </div>
    </div>`;

  const overlay = root.querySelector<HTMLElement>(".hiring-overlay")!;
  const rosterBox = root.querySelector<HTMLElement>(".hh-roster")!;
  const form = root.querySelector<HTMLFormElement>(".hh-form")!;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const submit = form.querySelector<HTMLButtonElement>("button")!;
  const status = root.querySelector<HTMLElement>(".hh-status")!;

  const mountTs = Date.now();
  let snapshot: RosterPayload | null = null;
  let activeRepo: string | null = null;
  let hiring = false;

  const setStatus = (text: string | null): void => {
    status.hidden = !text;
    status.textContent = text ?? "";
  };

  const renderRoster = (): void => {
    if (!opts.fetchRoster) {
      rosterBox.innerHTML = `<p class="empty">${t("hiring.liveOnly", { url: location.host })}</p>`;
      return;
    }
    rosterBox.innerHTML = snapshot ? rosterHtml(snapshot) : `<p class="empty">${t("hiring.unreadable")}</p>`;
  };

  const refreshRoster = (): void => {
    opts.fetchRoster?.()
      .then((roster) => {
        snapshot = roster;
        renderRoster();
      })
      .catch(() => renderRoster());
  };

  // baseline snapshot for walk-in diffing, even if the panel is never opened
  if (opts.fetchRoster) refreshRoster();
  else submit.disabled = true;

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const gap = input.value.trim();
    if (!gap || hiring || !opts.fetchRoster) return;
    hiring = true;
    submit.disabled = true;
    setStatus(t("hiring.inProgress"));
    fetch(`${HTTP_BASE}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: hirePrompt(gap), ...(activeRepo ? { repo: activeRepo } : {}) }),
    })
      .then(async (res) => {
        if (res.ok) {
          input.value = "";
          return;
        }
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        hiring = false;
        submit.disabled = false;
        setStatus(`⚠ ${body?.error ?? `Giao việc thất bại (HTTP ${res.status})`}`);
      })
      .catch(() => {
        hiring = false;
        submit.disabled = false;
        setStatus(t("hiring.noDaemon", { url: location.host }));
      });
  });

  overlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === overlay || target.closest(".hiring-close")) overlay.hidden = true;
  });

  return {
    open() {
      overlay.hidden = false;
      renderRoster();
      if (opts.fetchRoster) refreshRoster();
    },
    setRepo(repo) {
      activeRepo = repo;
    },
    onRaw(raw) {
      const frame = raw as RawRosterFrame;

      const diff = rosterFrameDiff(snapshot, frame, mountTs);
      if (diff) {
        for (const name of diff.newNames) opts.walkIn(name);
        snapshot = diff.roster;
        if (!overlay.hidden) renderRoster();
        if (diff.newNames.length > 0) {
          setStatus(t("hiring.joined", { names: diff.newNames.join(", ") }));
        }
        return;
      }

      // hire turn ends: the PM's reply lives in the chatbox, this is just the
      // panel's "đang tuyển…" light. ponytail: any finished turn of this
      // repo's PM clears it — single user, the chatbox holds the real story.
      if (frame.type === "chat_message" && hiring && frame.meta) {
        const { role, done, error, text } = frame.meta;
        if (role === "assistant" && done) {
          hiring = false;
          submit.disabled = false;
          setStatus(t("hiring.turnDone"));
        } else if (role === "system" && (done || error)) {
          hiring = false;
          submit.disabled = false;
          setStatus(`⚠ ${text ?? t("hiring.turnFailed")}`);
        }
      }
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
