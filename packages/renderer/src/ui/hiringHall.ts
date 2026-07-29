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
  return `Dùng skill company-hire: tuyển ${gap}. Báo cáo verdict scan + kết quả vào chat.`;
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
    return `<p class="empty">Chưa có roster — tuyển người đầu tiên bằng form dưới, hoặc chạy skill company-roster để bootstrap.</p>`;
  }
  const depts = roster.departments
    .map((d) => {
      const budget = d.budgetUsdPerDay !== null ? `<span class="hh-budget">trần $${d.budgetUsdPerDay}/ngày</span>` : "";
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
        ${d.members.length ? `<table class="hh-table">${rows}</table>` : `<p class="empty">phòng trống</p>`}
      </section>`;
    })
    .join("");
  return `<p class="hh-updated">Cập nhật roster: ${esc(roster.updated ?? "?")} · ${total} thành viên</p>${depts}`;
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
        <h2>🪪 Tuyển dụng <button class="hiring-close" title="Đóng">✕</button></h2>
        <p class="hh-note">Thành viên roster = skill/agent ĐÃ CÀI trên máy (từ ~/.claude/company/roster.yaml) — khác với nhân vật session đang chạy trong office.</p>
        <div class="hh-roster"><p class="empty">Đang tải…</p></div>
        <h3 class="hh-form-title">Tuyển người mới</h3>
        <form class="hh-form">
          <input type="text" placeholder="Mô tả gap — vd: cần thumbnail designer cho phòng media" />
          <button type="submit">Giao cho PM tuyển</button>
        </form>
        <p class="hh-status" hidden></p>
        <p class="hh-note">PM sẽ chạy skill <b>company-hire</b>: săn ứng viên GitHub → <b>bắt buộc</b> quét an toàn (skillspector) → cài → ghi roster. Theo dõi tiến trình ở chatbox; người mới sẽ đi qua cửa chào cả văn phòng.</p>
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
      rosterBox.innerHTML = `<p class="empty">Roster chỉ có ở live mode (cần daemon 127.0.0.1:8787).</p>`;
      return;
    }
    rosterBox.innerHTML = snapshot ? rosterHtml(snapshot) : `<p class="empty">Không đọc được roster — daemon có đang chạy không?</p>`;
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
    setStatus("⏳ PM đang tuyển… (company-hire: săn ứng viên → scan → cài). Chi tiết ở chatbox.");
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
        setStatus("⚠ Không kết nối được daemon (127.0.0.1:8787) — daemon có đang chạy không?");
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
          setStatus(`🎉 ${diff.newNames.join(", ")} đã vào roster.`);
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
          setStatus("✅ PM xong turn — xem kết quả ở chatbox. Người mới (nếu tuyển được) sẽ tự vào roster.");
        } else if (role === "system" && (done || error)) {
          hiring = false;
          submit.disabled = false;
          setStatus(`⚠ ${text ?? "PM turn lỗi"}`);
        }
      }
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
